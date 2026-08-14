import express from "express";
import path from "path";
import multer from "multer";
import { GoogleGenAI } from "@google/genai";
import { createServer as createViteServer } from "vite";
import fs from "fs";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";
import { PDFParse } from "pdf-parse";

const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 } // 100 MB max
});

// Cache for uploaded PDFs to optimize API calls
const documentCache = new Map<string, { buffer: Buffer, mimeType: string, text?: string }>();

const MAX_RETRIES = 5;

const supabaseServer = createClient(
  process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || "",
  process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || "",
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  }
);

async function requireSupabaseSession(req: any, res: any, next: any) {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";

    if (!token) {
      return res.status(401).json({ error: "Authentication required." });
    }

    if (!process.env.VITE_SUPABASE_URL || !process.env.VITE_SUPABASE_ANON_KEY) {
      return res.status(503).json({ error: "Authentication configuration is missing." });
    }

    const { data: { user }, error } = await supabaseServer.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ error: "Invalid or expired session." });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error("Supabase session validation failed:", error);
    return res.status(401).json({ error: "Invalid or expired session." });
  }
}

const FALLBACK_MODELS = [
  "gemini-3.5-flash",
  "gemini-3.1-pro-preview",
  "gemini-3.1-flash-lite",
  "gemini-flash-latest"
];

function getNextFallbackModel(currentModel: string): string | null {
  const currentIndex = FALLBACK_MODELS.indexOf(currentModel);
  if (currentIndex === -1) {
    return FALLBACK_MODELS[0];
  }
  if (currentIndex + 1 < FALLBACK_MODELS.length) {
    return FALLBACK_MODELS[currentIndex + 1];
  }
  return null;
}

async function generateWithRetry(ai: GoogleGenAI, request: any, retries = 0): Promise<any> {
  try {
    return await ai.models.generateContent(request);
  } catch (error: any) {
    if (retries >= MAX_RETRIES) {
      throw error;
    }
    
    const errorString = (typeof error === 'object' ? JSON.stringify(error) : String(error)).toLowerCase();
    console.warn(`[API Retry] Received error: ${error.message || errorString}`);
    const isRetryable = errorString.includes("503") || errorString.includes("429") || errorString.includes("quota") || errorString.includes("high demand") || errorString.includes("unavailable") || errorString.includes("overloaded");
    
    const isTooLarge = errorString.includes("token overflow") || errorString.includes("too many tokens") || errorString.includes("payload too large") || errorString.includes("too large");

    if (!isRetryable && !isTooLarge) {
      throw error;
    }

    const delay = Math.pow(1.5, retries) * 800 + Math.random() * 500;
    console.log(`[API Retry] Attempt ${retries + 1}/${MAX_RETRIES} failed. Retrying in ${Math.round(delay)}ms for model ${request.model}...`);
    
    let nextRequest = { ...request };
    
    if (isTooLarge && nextRequest.model !== "gemini-3.1-pro-preview") {
        console.log(`[API Retry] Payload too large. Falling back to gemini-3.1-pro-preview for larger context window...`);
        nextRequest.model = "gemini-3.1-pro-preview"; // 2M tokens context
    } else if (isRetryable) {
        const nextModel = getNextFallbackModel(nextRequest.model);
        if (nextModel) {
            console.log(`[API Retry] Model ${nextRequest.model} got error. Falling back to ${nextModel} to handle request...`);
            nextRequest.model = nextModel;
        } else {
            console.log(`[API Retry] No more fallback models in chain. Retrying with ${nextRequest.model} after backoff...`);
        }
    }
    
    await new Promise(resolve => setTimeout(resolve, delay));
    return generateWithRetry(ai, nextRequest, retries + 1);
  }
}

function classifyError(error: any): { statusCode: number, message: string } {
  const errorString = (typeof error === 'object' ? JSON.stringify(error) : String(error)).toLowerCase();
  
  if (errorString.includes("timeout") || error.name === "AbortError" || errorString.includes("deadline_exceeded")) {
      return { statusCode: 504, message: "Request timed out while waiting for the AI model to respond." };
  }
  if (errorString.includes("429") || errorString.includes("quota") || errorString.includes("rate limit") || errorString.includes("resource_exhausted")) {
      return { statusCode: 429, message: "API rate limit exceeded. The system is under heavy load." };
  }
  if (errorString.includes("token overflow") || errorString.includes("too many tokens") || errorString.includes("maximum context length") || errorString.includes("payload too large") || errorString.includes("too large")) {
      return { statusCode: 413, message: "Document overflow detected. The input context is too large." };
  }
  if (errorString.includes("failed to parse") || errorString.includes("invalid pdf") || errorString.includes("pdf parsing")) {
       return { statusCode: 400, message: "Failed to parse the provided document. The file might be corrupted." };
  }
  if (errorString.includes("no text returned") || errorString.includes("empty response")) {
      return { statusCode: 502, message: "The AI model returned an empty response, likely due to safety filters." };
  }
  if (errorString.includes("econnrefused") || errorString.includes("unreachable") || String(error.code) === "ENOTFOUND") {
      return { statusCode: 503, message: "Network failure while connecting to the AI provider." };
  }
  if (error.name === "SyntaxError" || errorString.includes("json")) {
       return { statusCode: 500, message: "The AI model produced invalid JSON format." };
  }
  return { statusCode: 500, message: `Backend exception occurred: ${error.message || "Unknown error"}.` };
}

function validateDocumentContent(text: string) {
  const forbidden = ["citation needed", "reference required", "todo", "manual verification needed", "[citation needed]", "[reference required]", "[todo]", "[manual verification needed]"];
  const lowerText = text.toLowerCase();
  for (const phrase of forbidden) {
    if (lowerText.includes(phrase)) {
       throw new Error(`Validation Error: Document contains forbidden placeholder: "${phrase}".`);
    }
  }
}

function validateEvaluationResults(parsedJSON: any, userInputs: any) {
  const userText = `${userInputs?.topic || ''} ${userInputs?.problemStatement || ''} ${userInputs?.objectives || ''} ${userInputs?.method || ''} ${userInputs?.dataset || ''}`.toLowerCase();
  
  const resultsSection = parsedJSON.sections?.find((s: any) => s.id === "results" || (s.title && s.title.toLowerCase().includes("results")));
  if (!resultsSection) return;

  const content = resultsSection.content.toLowerCase();
  
  const patterns = [
    /auroc\s*(?:=|of|is|:|>|<|~)?\s*(0\.\d+|\d{2}\.\d+%|\d+%)/i,
    /f1[- ]score\s*(?:=|of|is|:|>|<|~)?\s*(0\.\d+|\d{2}\.\d+%|\d+%)/i,
    /accuracy\s*(?:=|of|is|:|>|<|~)?\s*(0\.\d+|\d{2}\.\d+%|\d+%)/i,
    /recall\s*(?:=|of|is|:|>|<|~)?\s*(0\.\d+|\d{2}\.\d+%|\d+%)/i,
    /precision\s*(?:=|of|is|:|>|<|~)?\s*(0\.\d+|\d{2}\.\d+%|\d+%)/i,
    /(\d+(\.\d+)?)%\s*improvement/i,
    /outperformed baseline/i,
    /outperforms baseline/i
  ];

  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) {
      const metricValue = match[1]; // Captured number if any
      if (metricValue && !userText.includes(metricValue)) {
         throw new Error(`Validation Error: Fabricated experimental result detected (${match[0]}). Please provide experimental evidence or use Conceptual Research Mode.`);
      } else if (!metricValue && !userText.match(/outperform/i)) {
         throw new Error(`Validation Error: Unsupported benchmark claim detected (${match[0]}). Please provide experimental evidence.`);
      }
    }
  }
}

function extractPartialJSON(text: string, fallback?: any): any {
    try {
        return JSON.parse(text);
    } catch {
       // Best effort to extract whatever we can
       // Try adding closing brackets
       try {
           return JSON.parse(text + '"}');
       } catch {}
       try {
           return JSON.parse(text + '"]}');
       } catch {}
       try {
           return JSON.parse(text + ']}');
       } catch {}
       try {
           return JSON.parse(text + '}');
       } catch {}
       
       // Regex hack for partial paper parts
       const titleMatch = text.match(/"title":\s*"([^"]+)"/);
       const abstractMatch = text.match(/"abstract":\s*"([^"]+)"/);
       const sectionsMatch = [...text.matchAll(/{"id":\s*"([^"]+)",\s*"title":\s*"([^"]+)",\s*"content":\s*"([^"]+)"}/g)];
       
       if (titleMatch || sectionsMatch.length > 0) {
           return {
               title: titleMatch ? titleMatch[1] : "Generated Output (Partial)",
               abstract: abstractMatch ? abstractMatch[1] : "Abstract parsing failed.",
               sections: sectionsMatch.map((m, i) => ({
                   id: m[1] || `section-${i}`,
                   title: m[2] || `Section ${i+1}`,
                   content: m[3] || "Content parsing failed."
               })),
               references: "",
               partial: true
           };
       }

       if (fallback !== undefined) {
         return fallback;
       }
       throw new Error("Cannot recover partial JSON.");
    }
}

function parseGeminiJSON(text: string, fallback?: any) {
  let cleanText = text.trim();
  if (cleanText.startsWith("```json")) {
    cleanText = cleanText.substring(7);
  } else if (cleanText.startsWith("```")) {
    cleanText = cleanText.substring(3);
  }
  if (cleanText.endsWith("```")) {
    cleanText = cleanText.substring(0, cleanText.length - 3);
  }
  cleanText = cleanText.trim();
  return extractPartialJSON(cleanText, fallback);
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: "100mb" }));
  app.use(express.urlencoded({ limit: "100mb", extended: true }));

  // Init Gemini SDK
  const ai = new GoogleGenAI({ 
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      }
    }
  });

  // API endpoints
  app.post("/api/upload-document", requireSupabaseSession, (req, res, next) => {
    upload.single("paper")(req, res, (err) => {
      if (err) {
        console.error("Multer upload error:", err);
        if (err instanceof multer.MulterError) {
          if (err.code === "LIMIT_FILE_SIZE") {
            return res.status(400).json({ error: "File is too large. Maximum allowed size is 100MB." });
          }
          return res.status(400).json({ error: `Upload error: ${err.message}` });
        }
        return res.status(500).json({ error: err.message || "Failed to upload document" });
      }
      next();
    });
  }, async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      if (req.file.mimetype !== "application/pdf") {
        return res.status(400).json({ error: "Only PDF files are supported" });
      }

      const documentId = uuidv4();
      let extractedText: string | undefined = undefined;

      try {
        console.log("Extracting text from PDF using pdf-parse...");
        const parser = new PDFParse({ data: req.file.buffer });
        try {
          const parsedPdf = await parser.getText();
          extractedText = parsedPdf.text;
          console.log(`Successfully extracted ${extractedText?.length || 0} characters of text from PDF.`);
        } finally {
          await parser.destroy().catch((destroyErr: any) => {
            console.error("Failed to destroy PDFParse instance:", destroyErr);
          });
        }
      } catch (pdfErr: any) {
        console.error("Failed to extract text from PDF using pdf-parse:", pdfErr);
      }

      documentCache.set(documentId, {
        buffer: req.file.buffer,
        mimeType: req.file.mimetype,
        text: extractedText,
      });

      res.json({ documentId });
    } catch (error: any) {
      console.error("Error uploading document:", error);
      res.status(500).json({ error: "Failed to upload document" });
    }
  });

  app.post("/api/summarize-document", requireSupabaseSession, async (req, res) => {
    try {
      const { documentId } = req.body;
      if (!documentId || !documentCache.has(documentId)) {
        return res.status(400).json({ error: "Document not found or expired" });
      }

      const doc = documentCache.get(documentId);
      const base64Data = doc!.buffer.toString("base64");

      const prompt = `
        You are an expert AI research assistant. Please carefully read the provided academic or research paper.
        Extract the text from the paper and provide a response in valid JSON format with the following structure:
        {
          "summary": "A concise, 2-3 paragraph summary of the paper's main contributions, methodology, and conclusions.",
          "keyPoints": ["Point 1", "Point 2", "Point 3"],
          "keywords": ["Keyword1", "Keyword2"],
          "title": "The exact title of the paper",
          "methodologySummary": "A concise summary of the methodology used.",
          "resultsSummary": "A concise summary of the key findings and results.",
          "limitations": "A concise summary of limitations mentioned in the study.",
          "futureWorkSummary": "A concise summary of the future work or open questions highlighted.",
          "references": ["Ref 1", "Ref 2"]
        }
        Ensure the JSON is valid and strictly follows this schema. Do not include markdown blocks like \`\`\`json. Just the raw JSON object.
      `;

      console.log("Sending PDF to Gemini for summarization...");
      
      const hasExtractedText = doc?.text && doc.text.trim().length > 100;
      const contentParts = hasExtractedText 
        ? [
            { text: `Here is the extracted text of the research paper:\n\n${doc.text}\n\n` },
            { text: prompt }
          ]
        : [
            {
              inlineData: {
                data: base64Data,
                mimeType: "application/pdf"
              }
            },
            {
              text: prompt
            }
          ];

      const response = await generateWithRetry(ai, {
        model: "gemini-3.5-flash",
        contents: [
          {
            role: "user",
            parts: contentParts
          }
        ],
        config: {
          responseMimeType: "application/json"
        }
      });

      const responseText = response.text;
      
      if (!responseText) {
          throw new Error('No text returned from Gemini API.');
      }

      const parsedJSON = parseGeminiJSON(responseText);

      res.json({ result: parsedJSON });
    } catch (error: any) {
      console.error("Error calling Gemini API:", error);
      const { statusCode, message } = classifyError(error);
      res.status(statusCode).json({ error: message, details: error.message });
    }
  });

  app.post("/api/generate-paper", requireSupabaseSession, async (req, res) => {
    try {
      const data = req.body;
      const draftMode = data.draftMode || "submission";
      
      console.log(`Fetching real academic references for paper generation in ${draftMode} mode...`);
      const realReferences = await fetchAcademicReferences(ai, data.topic, data.keywords, data.domain);
      const formattedReferences = realReferences.slice(0, 8).map(r => 
        `- ${r.authors} (${r.year}). "${r.title}". ${r.container} - ${r.publisher}. DOI: ${r.doi}`
      ).join("\n");

      const prompt = `
        You are an expert academic writer and researcher. Generate a complete structured academic paper in "${draftMode.toUpperCase()}" mode based on the following inputs:
        - Topic: ${data.topic}
        - Domain: ${data.domain}
        - Keywords: ${data.keywords}
        - Problem Statement: ${data.problemStatement}
        - Objectives: ${data.objectives}
        - Proposed Method: ${data.method}
        - Dataset: ${data.dataset || "N/A"}
        - Paper Type: ${data.paperType}
        - Publication Format: ${data.publicationFormat}

        STRICT MODE-SPECIFIC RULES:
        ${draftMode === "draft" ? `
        - This is a WORKING DRAFT. Focus on fast structural outlines, clear description of the core mechanism, and room for collaborative ideas.
        - You MUST prefix the "title" with "[DRAFT] " so that it is explicitly and immediately distinguished as a working draft.
        - Under the References section, append a clear disclaimer at the end: "Note: This is a preliminary draft bibliography. Run full submission generation for final reference matching and citations check."
        ` : `
        - This is a FORMAL SUBMISSION paper ready for publishing.
        - The tone must be strictly authoritative, academic, objective, and dense.
        - Do NOT add "[DRAFT]" or any other qualifiers to the title. Keep it clean and highly professional.
        `}

        REAL VERIFIED REFERENCES PROVIDED TO YOU:
        ${formattedReferences || "No external references found. If verified references are unavailable, explicitly state that references could not be verified."}

        STRUCTURE RULES (MUST FOLLOW IEEE-STYLE):
        Generate EXACTLY these sections in this order:
        1. Introduction
        2. Literature Review
        3. Research Gap
        4. Proposed Methodology
        5. Experimental Setup
        6. Results & Discussion
        7. Conclusion

        FAKE REFERENCE PREVENTION & CITATION CONSISTENCY:
        - Do not generate fabricated references, fabricated DOIs, fake authors, or placeholder references.
        - Use ONLY verified references obtained through the reference retrieval pipelines (provided above).
        - If no references are provided above, output a single reference explicitly stating "References could not be verified."
        - Every in-text citation must logically correspond to an entry in the References section. Remove unused references.
        - Ensure reference numbering and citation numbering remain synchronized.
        - Validate bibliographic metadata before inclusion. Reject duplicate references, invalid DOIs, and unrelated references.

        LITERATURE REVIEW & GAP RULES:
        - Expand literature review with critical analysis. Explain limitations of existing approaches.
        - Clearly identify the research gap.
        - When sufficient references exist, generate a concise comparative literature table using Markdown format.

        DATASET, BASELINES, & PROCEDURES (IF APPLICABLE):
        - Dataset Specification: Avoid generic phrases such as "medical datasets". Explicitly mention specific datasets when relevant (e.g., MIMIC-IV, CheXpert) appropriate to the domain.
        - Baseline Models: Define comparison baselines whenever methodology is proposed (e.g., ResNet50, ClinicalBERT) relevant to the domain.
        - Evaluation Metrics: Explicitly define appropriate evaluation metrics (e.g., Accuracy, Precision, Recall, F1-Score, AUROC, ROUGE-L).
        - RAG Justification: If Retrieval-Augmented Generation (RAG) is used, explain why it is preferred, compare it against fine-tuning-only approaches, and discuss explainability, knowledge updates, and hallucination reduction.

        RESULTS SECTION RULES (STRICT EVIDENCE-BASED POLICY):
        - Do NOT generate fabricated experimental results (e.g., Accuracy values, AUROC, F1-scores, Precision, Recall, percentage improvements, benchmark rankings, numerical comparisons).
        - Conceptual Research Mode: If experimental results or benchmark data are not explicitly provided by the user in the inputs, you MUST replace Results & Discussion with: Expected Outcomes, Evaluation Plan, Proposed Validation Strategy, and Future Experimental Work. Use phrasing such as "The framework is expected to...", "Future validation will evaluate...", "Performance will be assessed using...".
        - Allow dataset descriptions, baseline model descriptions, evaluation metric definitions, and validation methodology.
        - Experimental Research Mode: Only generate numerical results when the user explicitly provides experimental results, benchmark outputs, or evaluation metrics in their inputs.

        ACADEMIC WRITING QUALITY & CRITICAL INSTRUCTIONS:
        1. Maintain formal academic tone. Remove promotional language. Avoid unsupported claims.
        2. NO PLACEHOLDERS: Do NOT include "TODO", "[Citation Needed]", "Reference Required", "Manual Verification Needed", "Insert here", or sample content.
        3. NO GENERIC CONTENT: Write ONLY project-specific academic paper details.
        4. STRICT TECH DECISIONS: Pick ONE definitive setup.
        5. Keep each section content extremely concise (approx. 100-150 words) to prevent truncation. Output raw markdown inside JSON.
        6. Ensure all text values are properly escaped for valid JSON (no raw newlines or tabs in strings).

        Return a valid JSON object matching this schema:
        {
          "title": "Generated Title",
          "abstract": "Abstract content",
          "keywords": ["key1", "key2"],
          "sections": [
            {"id": "intro", "title": "1. Introduction", "content": "Markdown content..."},
            {"id": "lit", "title": "2. Literature Review", "content": "Markdown content..."},
            {"id": "gap", "title": "3. Research Gap", "content": "Markdown content..."},
            {"id": "method", "title": "4. Proposed Methodology", "content": "Markdown content..."},
            {"id": "setup", "title": "5. Experimental Setup", "content": "Markdown content..."},
            {"id": "results", "title": "6. Results & Discussion", "content": "Markdown content..."},
            {"id": "conclusion", "title": "7. Conclusion", "content": "Markdown content..."}
          ],
          "references": "Text or markdown of references properly formatted."
        }
        Ensure the output is raw JSON with no markdown wrapping (i.e. no \`\`\`json).
      `;

      const response = await generateWithRetry(ai, {
        model: "gemini-3.5-flash",
        contents: prompt,
        config: { responseMimeType: "application/json" }
      });

      const responseText = response.text;
      if (!responseText) throw new Error("No text returned from API.");
      
      validateDocumentContent(responseText);

      const parsedJSON = parseGeminiJSON(responseText);
      validateEvaluationResults(parsedJSON, data);
      
      res.json({ result: parsedJSON });
    } catch (error: any) {
      console.error("Error generating paper:", error);
      const { statusCode, message } = classifyError(error);
      res.status(statusCode).json({ error: message, details: error.message });
    }
  });

  app.post("/api/suggest-assistance", requireSupabaseSession, async (req, res) => {
    try {
      const { topic, domain, assistanceType, currentContent } = req.body;
      const prompt = `
        You are an expert AI research assistant. The user is writing a paper on the topic: "${topic}" within the domain "${domain}".
        The user is asking for assistance of type: "${assistanceType}".
        Additional context provided by the user: "${currentContent || 'None'}"
        
        Provide a detailed, helpful markdown response fulfilling this request. Avoid vague advice, give concrete suggestions.
      `;

      const response = await generateWithRetry(ai, {
        model: "gemini-3.5-flash",
        contents: prompt
      });

      res.json({ result: response.text });
    } catch (error: any) {
      console.error("Error generating assistance:", error);
      const { statusCode, message } = classifyError(error);
      res.status(statusCode).json({ error: message, details: error.message });
    }
  });

async function fetchAcademicReferences(ai: GoogleGenAI, topic: string, keywords: string, domain: string) {
      const queryContext = `${topic} ${keywords || ''} ${domain || ''}`.trim();
      
      let searchQuery = queryContext.replace(/[^\w\s]/gi, '').split(/\s+/).slice(0, 4).join(" ") || queryContext.substring(0, 30);
      
      console.log("Searching Crossref, Semantic Scholar, PubMed, and arXiv for:", searchQuery);
      
      const crossrefUrl = `https://api.crossref.org/works?query=${encodeURIComponent(searchQuery)}&select=title,author,issued,DOI,publisher,container-title&rows=10`;
      const semanticUrl = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(searchQuery)}&limit=10&fields=title,authors,year,url,venue,externalIds`;
      const pubmedSearchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(searchQuery)}&retmode=json&retmax=5`;
      const arxivUrl = `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(searchQuery)}&start=0&max_results=5`;

      const fetchWithTimeout = async (url: string, ms = 4000) => {
          const controller = new AbortController();
          const id = setTimeout(() => controller.abort(), ms);
          try {
              const res = await fetch(url, { signal: controller.signal });
              clearTimeout(id);
              return res;
          } catch (e) {
              clearTimeout(id);
              return null;
          }
      };

      const [crossrefRes, semanticRes, pubmedSearchRes, arxivRes] = await Promise.all([
        fetchWithTimeout(crossrefUrl),
        fetchWithTimeout(semanticUrl),
        fetchWithTimeout(pubmedSearchUrl),
        fetchWithTimeout(arxivUrl)
      ]);

      let references: any[] = [];

      // 1. Crossref
      if (crossrefRes && crossrefRes.ok) {
        try {
          const crossrefData = await crossrefRes.json();
          const items = crossrefData?.message?.items || [];
          const validItems = items.filter((item: any) => item.title && item.author && item.DOI);
          
          const crossrefRefs = validItems.map((item: any) => {
            let authors = "";
            if (Array.isArray(item.author)) {
              authors = item.author.map((a: any) => `${a.given || ""} ${a.family || ""}`.trim()).join(", ");
            }
            let year = "N/A";
            if (item.issued && item.issued["date-parts"] && item.issued["date-parts"][0] && item.issued["date-parts"][0][0]) {
              year = item.issued["date-parts"][0][0];
            }
            return {
              title: item.title[0] || "Unknown Title",
              authors,
              year,
              doi: item.DOI,
              publisher: item.publisher || "Crossref",
              container: item["container-title"] ? item["container-title"][0] : "",
              url: `https://doi.org/${item.DOI}`,
              source: "Crossref",
              verified: { doi: true, authors: true, source: true }
            };
          });
          references = [...references, ...crossrefRefs];
        } catch(e) { console.error("Crossref parsing error"); }
      }

      // 2. Semantic Scholar
      if (semanticRes && semanticRes.ok) {
        try {
            const semanticData = await semanticRes.json();
            const items = semanticData?.data || [];
            
            const semanticRefs = items.filter((item:any) => item.title && item.authors).map((item: any) => {
              const authors = item.authors.map((a: any) => a.name).join(", ");
              const doi = item.externalIds?.DOI || "N/A";
              return {
                title: item.title,
                authors,
                year: item.year || "N/A",
                doi,
                publisher: "Semantic Scholar",
                container: item.venue || "",
                url: item.url || (doi !== "N/A" ? `https://doi.org/${doi}` : ""),
                source: "Semantic Scholar",
                verified: { doi: doi !== "N/A", authors: true, source: true }
              };
            });
            
            for (const ref of semanticRefs) {
                if (!references.some(r => r.title.toLowerCase() === ref.title.toLowerCase())) {
                    references.push(ref);
                }
            }
        } catch(e) { console.error("Semantic Scholar parsing error"); }
      }

      // 3. PubMed
      if (pubmedSearchRes && pubmedSearchRes.ok) {
         try {
             const pubmedSearchData = await pubmedSearchRes.json();
             const idList = pubmedSearchData?.esearchresult?.idlist || [];
             if (idList.length > 0) {
                 const pubmedSummaryUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${idList.join(",")}&retmode=json`;
                 const pubmedSummaryRes = await fetchWithTimeout(pubmedSummaryUrl);
                 if (pubmedSummaryRes && pubmedSummaryRes.ok) {
                    const pubmedSummaryData = await pubmedSummaryRes.json();
                    const results = pubmedSummaryData?.result || {};
                    for (const id of idList) {
                       const item = results[id];
                       if (item && item.title) {
                          const pubmedTitle = item.title;
                          if (!references.some(r => r.title.toLowerCase() === pubmedTitle.toLowerCase())) {
                              references.push({
                                 title: pubmedTitle,
                                 authors: item.authors ? item.authors.map((a:any) => a.name).join(", ") : "Unknown",
                                 year: item.pubdate ? item.pubdate.split(" ")[0] : "N/A",
                                 doi: item.articleids ? (item.articleids.find((aid:any) => aid.idtype === 'doi')?.value || "N/A") : "N/A",
                                 publisher: "NCBI",
                                 container: item.fulljournalname || item.source || "",
                                 url: `https://pubmed.ncbi.nlm.nih.gov/${item.uid}/`,
                                 source: "PubMed",
                                 verified: { doi: item.articleids?.some((aid:any) => aid.idtype === 'doi'), authors: true, source: true }
                              });
                          }
                       }
                    }
                 }
             }
         } catch(e) { console.error("PubMed parsing error"); }
      }

      // 4. arXiv
      if (arxivRes && arxivRes.ok) {
         try {
             const arxivText = await arxivRes.text();
             const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
             let match;
             while ((match = entryRegex.exec(arxivText)) !== null) {
                 const entryStr = match[1];
                 const titleMatch = /<title>([\s\S]*?)<\/title>/.exec(entryStr);
                 const publishedMatch = /<published>([\s\S]*?)<\/published>/.exec(entryStr);
                 const idMatch = /<id>([\s\S]*?)<\/id>/.exec(entryStr);
                 const authorsMatches = [...entryStr.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g)];
                 const doiMatch = /<arxiv:doi xmlns:arxiv="[\s\S]*?">([\s\S]*?)<\/arxiv:doi>/.exec(entryStr);
                 const journalMatch = /<arxiv:journal_ref xmlns:arxiv="[\s\S]*?">([\s\S]*?)<\/arxiv:journal_ref>/.exec(entryStr);

                 const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : "Unknown Title";
                 if (!references.some(r => r.title.toLowerCase() === title.toLowerCase())) {
                     references.push({
                        title,
                        authors: authorsMatches.map(m => m[1]).join(", ") || "Unknown",
                        year: publishedMatch ? publishedMatch[1].substring(0, 4) : "N/A",
                        doi: doiMatch ? doiMatch[1] : "N/A",
                        publisher: "arXiv",
                        container: journalMatch ? journalMatch[1] : "arXiv pre-print",
                        url: idMatch ? idMatch[1] : "",
                        source: "arXiv",
                        verified: { doi: !!doiMatch, authors: true, source: true }
                     });
                 }
             }
         } catch(e) { console.error("arXiv parsing error"); }
      }
      
      const currentYear = new Date().getFullYear();
      const uniqueRefs: any[] = [];
      const seenTitles = new Set();
      
      references.forEach(r => {
        // Validate publication year
        if (r.year !== "N/A") {
          const yearNum = parseInt(r.year);
          if (!isNaN(yearNum) && yearNum > currentYear) return;
        }
        
        // Validate DOI format
        if (r.doi && r.doi !== "N/A" && !r.doi.startsWith("10.")) return;
        
        // Ensure no duplicates
        const normTitle = r.title.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (!seenTitles.has(normTitle)) {
           uniqueRefs.push(r);
           seenTitles.add(normTitle);
        }
      });
      
      return uniqueRefs;
}

  app.post("/api/find-references", requireSupabaseSession, async (req, res) => {
    try {
      const data = req.body;
      let references = await fetchAcademicReferences(ai, data.topic, data.keywords, data.domain);
      
      if (references.length > 0) {
        // AI Validation: Relevance and future-year blocking
        const validationPrompt = `
You are an expert academic reference reviewer.
Document Topic: "${data.topic}"
Target Domain: "${data.domain}"
Current Calendar Year: ${new Date().getFullYear()}

Given the following candidate references, validate their relevance and year.
1. Future-Year Blocking: Reject any reference whose year is greater than ${new Date().getFullYear()} (e.g., if year is ${new Date().getFullYear() + 1}).
2. Relevance Validation: Reject any reference that falls below a high relevance threshold to the topic and domain. Reject references from entirely unrelated domains.

Output raw JSON ONLY with this schema:
{
  "accepted": [ { ...ref }, ... ],
  "rejected": [ { "reference": { ...ref }, "reason": "Explanation" }, ... ]
}

Candidate References:
${JSON.stringify(references, null, 2)}
`;
        try {
          const validationResponse = await generateWithRetry(ai, {
            model: "gemini-3.5-flash",
            contents: validationPrompt,
            config: { responseMimeType: "application/json" }
          });
          const validationResult = parseGeminiJSON(validationResponse.text);
          if (validationResult && validationResult.accepted) {
            references = validationResult.accepted;
            if (validationResult.rejected && validationResult.rejected.length > 0) {
              console.log("[Reference Validation] Rejected references:");
              validationResult.rejected.forEach((rej: any) => {
                console.log(`- ${rej.reference.title}: ${rej.reason}`);
              });
            }
          }
        } catch (validationErr) {
          console.error("AI Validation error, proceeding with initial refs:", validationErr);
        }
      }

      if (references.length === 0) {
          console.log("External APIs and validation returned no results, falling back to basic result...");
          res.json({ result: [{
             title: "No verified references found online limit or error",
             authors: "N/A",
             year: "N/A",
             doi: "N/A",
             publisher: "N/A",
             container: "N/A",
             url: "",
             source: "Fallback",
             verified: { doi: false, authors: false, source: false }
          }], query: data.topic });
          return;
      }
      
      res.json({ result: references.slice(0, 15), query: `${data.topic} ${data.keywords}`.trim() });
    } catch (error: any) {
      console.error("Error finding references:", error);
      res.status(500).json({ error: "Failed to find verified references. Please try again." });
    }
  });

  app.post("/api/chat-document", requireSupabaseSession, async (req, res) => {
    try {
      const { documentId, history, message } = req.body;
      if (!documentId || !documentCache.has(documentId)) {
        return res.status(400).json({ error: "Document not found or expired" });
      }

      const doc = documentCache.get(documentId);
      const base64Data = doc!.buffer.toString("base64");

      const systemInstruction = `
        You are a helpful AI research assistant. Answer questions based ONLY on the provided document research paper.
        If the information is not available in the document, say "I cannot find this information in the uploaded document."
        Limit your knowledge strictly to the content of the document context, but format boundaries so you look nice.
      `;

      // Construct contents array with the document attached to the earliest message
      const contents = [];
      const hasExtractedText = doc?.text && doc.text.trim().length > 100;
      
      // If history is empty, attach document to the first message part
      if (!history || history.length === 0) {
        if (hasExtractedText) {
          contents.push({
            role: "user",
            parts: [
              { text: `Context of the uploaded research paper:\n\n${doc.text}\n\nInstructions: Provide answers using the context provided above.` },
              { text: message }
            ]
          });
        } else {
          contents.push({
            role: "user",
            parts: [
              { inlineData: { data: base64Data, mimeType: "application/pdf" } },
              { text: message }
            ]
          });
        }
      } else {
        // history has previous messages
        if (hasExtractedText) {
          contents.push({
            role: "user",
            parts: [
              { text: `Context of the uploaded research paper:\n\n${doc.text}\n\nInstructions: Provide answers using the context provided above.` },
              { text: history[0].text } // Assuming history[0] is user
            ]
          });
        } else {
          contents.push({
            role: "user",
            parts: [
              { inlineData: { data: base64Data, mimeType: "application/pdf" } },
              { text: history[0].text } // Assuming history[0] is user
            ]
          });
        }
        
        // append rest of history
        for (let i = 1; i < history.length; i++) {
          contents.push({
            role: history[i].role,
            parts: [{ text: history[i].text }]
          });
        }
        
        // append current message
        contents.push({
          role: "user",
          parts: [{ text: message }]
        });
      }

      console.log("Processing chat request...");
      
      const response = await generateWithRetry(ai, {
        model: "gemini-3.5-flash",
        contents: contents,
        config: {
           systemInstruction: systemInstruction,
        }
      });

      res.json({ result: response.text });
    } catch (error: any) {
      console.error("Error chatting with document:", error);
      const { statusCode, message } = classifyError(error);
      res.status(statusCode).json({ error: message, details: error.message });
    }
  });

  app.post("/api/analyze-gaps", requireSupabaseSession, async (req, res) => {
    try {
      const data = req.body;
      const { title, domain, description } = data;
      
      const queryContext = `${title} ${domain} ${description || ""}`.trim();
      
      const searchQuery = queryContext.replace(/[^\w\s]/gi, '').split(/\s+/).slice(0, 4).join(" ") || queryContext.substring(0, 30);

      const fetchWithTimeout = async (url: string, ms = 7000) => {
          const controller = new AbortController();
          const id = setTimeout(() => controller.abort(), ms);
          try {
              const res = await fetch(url, { signal: controller.signal });
              clearTimeout(id);
              return res;
          } catch (e) {
              clearTimeout(id);
              return null;
          }
      };

      console.log("Analyzing gaps using Semantic Scholar and arXiv for query:", searchQuery);
      const semanticUrl = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(searchQuery)}&limit=5&fields=title,authors,abstract`;
      const arxivUrl = `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(searchQuery)}&start=0&max_results=5`;

      const [semanticRes, arxivRes] = await Promise.all([
        fetchWithTimeout(semanticUrl),
        fetchWithTimeout(arxivUrl)
      ]);

      let abstracts: any[] = [];
      
      if (semanticRes && semanticRes.ok) {
        try {
            const semanticData = await semanticRes.json();
            const items = semanticData?.data || [];
            abstracts = items.filter((i:any) => i.title && i.abstract).map((i:any) => ({
                title: i.title,
                authors: i.authors ? i.authors.map((a:any) => a.name).join(", ") : "Unknown",
                abstract: i.abstract
            }));
        } catch(e) {}
      }

      if (arxivRes && arxivRes.ok) {
          try {
             const arxivText = await arxivRes.text();
             const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
             let match;
             while ((match = entryRegex.exec(arxivText)) !== null) {
                 const entryStr = match[1];
                 const titleMatch = /<title>([\s\S]*?)<\/title>/.exec(entryStr);
                 const summaryMatch = /<summary>([\s\S]*?)<\/summary>/.exec(entryStr);
                 const authorsMatches = [...entryStr.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g)];
                 const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : "Unknown Title";
                 const summary = summaryMatch ? summaryMatch[1].replace(/\s+/g, ' ').trim() : "";
                 if (title && summary && !abstracts.some(a => a.title.toLowerCase() === title.toLowerCase())) {
                     abstracts.push({
                        title,
                        authors: authorsMatches.map(m => m[1]).join(", ") || "Unknown",
                        abstract: summary
                     });
                 }
             }
          } catch(e) {}
      }

      if (abstracts.length === 0) {
          abstracts.push({
              title: "General literature in " + domain,
              authors: "Various",
              abstract: "It is widely acknowledged that existing solutions in this area face challenges with scalability, integration overhead, and a lack of specific optimization. Future work consistently recommends domain-specific adaptations and more robust evaluation metrics."
          });
      }

      const prompt = `
        You are an expert Research Gap Analysis Engine.
        Analyze the following academic paper abstracts/summaries (retrieved based on the query: "${searchQuery}") 
        to identify research gaps and map them to the proposed project: "${title}" in the domain of "${domain}".

        Retrieved Literature:
        ${abstracts.slice(0, 8).map((a: any, i: number) => `Paper ${i+1}: ${a.title}\nAuthors: ${a.authors}\nAbstract/Context: ${a.abstract}\n`).join("\n")}
        
        Proposed Project:
        Title: ${title}
        Domain: ${domain}
        Description: ${description || "Unknown"}

        CRITICAL INSTRUCTIONS:
        1. Identify 3-4 specific recurring gaps, limitations, or future work opportunities exactly derived from the literature provided above (Methodology Weaknesses, Dataset Limitations, etc).
        2. Generate a "Novelty Statement" for the proposed project.
        3. Explain exactly how the project addresses the identified gaps (Project-to-Gap Mapping).
        4. Give a confidence score (0-100) for how well the project addresses the gaps.
        5. Provide 2-3 Future Research Directions.
        6. Output ONLY valid JSON, according to the schema below. Output must be raw JSON with no markdown block wrappers.
        
        {
          "report": {
            "query": "${searchQuery}",
            "noveltyStatement": "Markdown...",
            "gaps": [
               {
                 "title": "Gap Title",
                 "description": "Gap description...",
                 "foundIn": "Paper 1, Paper 2..."
               }
            ],
            "projectMapping": "Markdown explaining how the project maps to the gaps...",
            "futureDirections": ["Direction 1", "Direction 2"],
            "confidenceScore": 85
          }
        }
      `;

      const response = await generateWithRetry(ai, {
        model: "gemini-3.5-flash",
        contents: prompt,
        config: {
            temperature: 0.2
        }
      });
      
      const jsonResult = parseGeminiJSON(response.text || "");
      res.json({ result: jsonResult.report });
    } catch(err: any) {
      console.error(err);
      res.status(500).json({ error: "Failed to perform gap analysis."});
    }
  });

  app.post("/api/generate-project", requireSupabaseSession, async (req, res) => {
    try {
      const data = req.body;
      
      console.log("Fetching real academic references for project generation...");
      const realReferences = await fetchAcademicReferences(ai, data.title, data.technologies, data.domain);
      const formattedReferences = realReferences.slice(0, 8).map(r => 
        `- ${r.authors} (${r.year}). "${r.title}". ${r.container} - ${r.publisher}. DOI: ${r.doi}`
      ).join("\n");

      const prompt = `
        You are an expert technical project consultant and academic assistant. Generate a comprehensive project structure and document based on the following:
        - Title: ${data.title}
        - Domain: ${data.domain}
        - Objectives: ${data.objectives}
        - Technologies: ${data.technologies}
        - Description: ${data.description}
        - Expected Outcomes: ${data.expectedOutcomes}
        - Project Type: ${data.projectType}
        
        REAL VERIFIED REFERENCES PROVIDED TO YOU:
        ${formattedReferences || "No external references found. If verified references are unavailable, do not invent them."}

        CRITICAL RULES:
        1. NO ACADEMIC PAPER CONTENT: Project Reports must NOT resemble research papers.
        2. STRUCTURE: Use exactly this professional software documentation structure:
           - 1. Introduction
           - 2. Problem Statement
           - 3. Objectives
           - 4. Scope
           - 5. System Architecture
           - 6. Module Description
           - 7. Workflow
           - 8. Technology Stack
           - 9. Database Design
           - 10. Implementation Details
           - 11. Testing Strategy
           - 12. Deployment Plan
           - 13. Future Scope
           - 14. Conclusion
        3. REMOVE: Do NOT include Research Gap sections, Experimental Setup sections, Academic paper-style Results sections, or Viva Questions.
        4. PROFESSIONAL FORMATTING: Maintain clean LaTeX-quality formatting. Use section hierarchy, numbering, and consistent typography suitable for university project submissions.
        5. REFERENCES: Only include references when directly relevant. Project reports should not force large academic reference sections. Never invent them.
        6. NO PLACEHOLDERS: Do NOT include "TODO", "[Citation Needed]", "Reference Required", "Manual Verification Needed", "Insert here", or sample content.
        7. EXPECTED OUTCOMES: Must be qualitative and realistic; do not invent fake numerical improvements.
        8. Keep each section content extremely concise to prevent truncation. Output raw markdown inside JSON. Ensure all text values are properly escaped for valid JSON.

        Output should be a JSON object with this schema:
        {
          "title": "Generated Project Title",
          "domain": "Project Domain",
          "projectType": "Project Type",
          "sections": [
            {"id": "abstract", "title": "Project Abstract", "content": "Markdown content..."},
            {"id": "intro", "title": "1. Introduction", "content": "Markdown content..."},
            {"id": "prob", "title": "2. Problem Statement", "content": "Markdown content..."},
            {"id": "obj", "title": "3. Objectives", "content": "Markdown content..."},
            {"id": "scope", "title": "4. Scope", "content": "Markdown content..."},
            {"id": "arch", "title": "5. System Architecture", "content": "Markdown content..."},
            {"id": "modules", "title": "6. Module Description", "content": "Markdown content..."},
            {"id": "workflow", "title": "7. Workflow", "content": "Markdown content..."},
            {"id": "tech", "title": "8. Technology Stack", "content": "Markdown content..."},
            {"id": "db", "title": "9. Database Design", "content": "Markdown content..."},
            {"id": "implementation", "title": "10. Implementation Details", "content": "Markdown content..."},
            {"id": "testing", "title": "11. Testing Strategy", "content": "Markdown content..."},
            {"id": "deploy", "title": "12. Deployment Plan", "content": "Markdown content..."},
            {"id": "future", "title": "13. Future Scope", "content": "Markdown content..."},
            {"id": "conclusion", "title": "14. Conclusion", "content": "Markdown content..."},
            {"id": "references", "title": "15. References", "content": "Markdown content..."}
          ]
        }
        Ensure the output is raw JSON with no markdown wrapping (\`\`\`json).
      `;

      const response = await generateWithRetry(ai, {
        model: "gemini-3.5-flash",
        contents: prompt,
        config: { responseMimeType: "application/json" }
      });

      const responseText = response.text;
      if (!responseText) throw new Error("No text returned from API.");

      validateDocumentContent(responseText);

      const parsedJSON = parseGeminiJSON(responseText);
      res.json({ result: parsedJSON });
    } catch (error: any) {
      console.error("Error generating project:", error);
      const { statusCode, message } = classifyError(error);
      res.status(statusCode).json({ error: message, details: error.message });
    }
  });

  app.post("/api/resume-generation", requireSupabaseSession, async (req, res) => {
    try {
      const { type, existingContent, promptData } = req.body;
      
      const prompt = `
        You are an expert academic writer. You were generating a ${type} but stopped prematurely.
        The following content has already been generated:
        ${JSON.stringify(existingContent, null, 2)}
        
        Original request details:
        ${JSON.stringify(promptData, null, 2)}
        
        Please continue generating the remaining sections. Return ONLY a JSON object containing the MISSING sections, following this schema:
        {
           "sections": [
              {"id": "missing_id_1", "title": "Missing Title 1", "content": "Markdown content..."},
              ...
           ],
           "references": "Text or markdown of references properly formatted."
        }
        Output raw JSON with no markdown wrapping.
      `;

      const response = await generateWithRetry(ai, {
        model: "gemini-3.5-flash",
        contents: prompt,
        config: { responseMimeType: "application/json" }
      });

      const parsedJSON = parseGeminiJSON(response.text || "");
      if (type === "research paper") validateEvaluationResults(parsedJSON, promptData);
      res.json({ result: parsedJSON });
    } catch (error: any) {
      console.error("Error resuming generation:", error);
      const { statusCode, message } = classifyError(error);
      res.status(statusCode).json({ error: message, details: error.message });
    }
  });

  app.post("/api/check-compliance", requireSupabaseSession, async (req, res) => {
    try {
      const { publicationFormat, paperContent } = req.body;
      const textToAnalyze = paperContent ? paperContent.substring(0, 50000) : "No content provided.";
      
      const compliancePrompt = `
        You are an expert Document Quality Enforcement Engine. Review the document against ${publicationFormat || 'Academic'} guidelines.
        
        Analyze the document for the following categories and return a strict JSON output.
        - Citation Analysis: Verify citations are fully formed (Authors, Year, Title, Venue, DOI if applicable). Identify placeholders like [Citation Needed] or missing references.
        - Literature Analysis: Evaluate the literature review. Is it relevant, specific, and does it use verified academic sources? Are there generic textbook explanations?
        - Methodology Analysis: Ensure Experimental Setup explicitly includes: Dataset, Evaluation Metrics, Baselines, and Methodology. Ensure Expected Results are deeply project-specific.
        - Writing Analysis: Evaluate tone, technical depth, grammar, and readability. Ensure ONE specific technology stack is chosen.
        
        Format exact JSON without markdown codeblock:
        {
           "citation": { "score": 90, "issues": ["issue 1"], "recommendations": ["rec 1"] },
           "literature": { "score": 85, "issues": [], "recommendations": [] },
           "methodology": { "score": 88, "issues": [], "recommendations": [] },
           "writing": { "score": 95, "issues": [], "recommendations": [] }
        }
        
        Paper Content snippet:
        ${textToAnalyze}
      `;

      const fallbackResult = {
         citation: { score: 0, issues: ["Failed to parse citation result"], recommendations: [] },
         literature: { score: 0, issues: ["Failed to parse literature result"], recommendations: [] },
         methodology: { score: 0, issues: ["Failed to parse methodology result"], recommendations: [] },
         writing: { score: 0, issues: ["Failed to parse writing result"], recommendations: [] }
      };

      console.log("[Compliance] Sending single validation request...");
      const startTime = Date.now();
      const response = await generateWithRetry(ai, {
          model: "gemini-3.5-flash",
          contents: compliancePrompt,
          config: { responseMimeType: "application/json" }
      });
      const elapsedTime = Date.now() - startTime;
      console.log(`[Compliance] Single check completed in ${elapsedTime}ms.`);

      const result = parseGeminiJSON(response.text || "", fallbackResult);
      
      const citationResult = result.citation || fallbackResult.citation;
      const litResult = result.literature || fallbackResult.literature;
      const methodResult = result.methodology || fallbackResult.methodology;
      const writingResult = result.writing || fallbackResult.writing;
      
      const citation = typeof citationResult.score === 'number' ? citationResult.score : 0;
      const lit = typeof litResult.score === 'number' ? litResult.score : 0;
      const method = typeof methodResult.score === 'number' ? methodResult.score : 0;
      const writing = typeof writingResult.score === 'number' ? writingResult.score : 0;
      
      // Force mathematical consistency
      const calcOverall = Math.round((citation + lit + method + writing) / 4);

      let criticalIssues = [
          ...(citationResult.issues || []),
          ...(litResult.issues || []),
          ...(methodResult.issues || []),
          ...(writingResult.issues || [])
      ].filter((x: string) => x);

      let recommendations = [
          ...(citationResult.recommendations || []),
          ...(litResult.recommendations || []),
          ...(methodResult.recommendations || []),
          ...(writingResult.recommendations || [])
      ].filter((x: string) => x);

      // Prevent impossible states
      const textLower = (paperContent || "").toLowerCase();
      const hasPlaceholders = textLower.includes("reference required") || 
                              textLower.includes("citation needed") || 
                              textLower.includes("manual verification needed") ||
                              textLower.includes("todo");

      let exportAllowed = true;

      if (hasPlaceholders) {
         criticalIssues.push("Found placeholders like 'TODO' or 'Citation Needed' in raw text. Please review.");
      }

      res.json({ result: {
          scores: {
             overall: hasPlaceholders && calcOverall === 100 ? 50 : calcOverall,
             citationAccuracy: citation,
             literatureQuality: lit,
             methodologyConsistency: method,
             academicWriting: writing
          },
          exportAllowed,
          criticalIssues,
          recommendations
      } });
    } catch(err: any) {
      console.error(err);
      res.status(500).json({ error: "Failed to run compliance check.", details: err.message });
    }
  });

  app.post("/api/review-paper", requireSupabaseSession, async (req, res) => {
    try {
      const { paperContent } = req.body;
      const textToAnalyze = paperContent ? paperContent.substring(0, 50000) : "No content provided.";
      
      const reviewPrompt = `
        You are an expert peer reviewer for top-tier academic journals. Review the following research paper.
        
        Evaluate the following elements strictly:
        1. Citation Consistency (Missing citations, Unused references, Citation-reference mismatches)
        2. Literature Review Quality (Coverage, Research gap clarity, Critical analysis)
        3. Methodology Quality (Clarity, Reproducibility, Technical completeness)
        4. Dataset Quality (Missing datasets, Appropriateness)
        5. Evaluation Design (Missing baselines, Evaluation metrics)
        6. Reference Quality (Relevance, Completeness, DOI presence)
        7. Academic Writing Quality (Formal tone, Redundancy, Unsupported claims)
        
        Format exact JSON without markdown codeblock wrapper:
        {
           "overallScore": 85,
           "categoryScores": {
              "novelty": 80,
              "technicalDepth": 85,
              "literatureReview": 80,
              "methodology": 90,
              "references": 85,
              "academicWriting": 95,
              "reproducibility": 80
           },
           "strengths": ["Clear introduction", "Good methodology structure"],
           "weaknesses": ["Missing baselines", "References lacking DOIs"],
           "actionableImprovements": ["Add ResNet50 baseline", "Update references with DOIs"]
        }
        
        Paper Content snippet:
        ${textToAnalyze}
      `;

      const response = await generateWithRetry(ai, {
          model: "gemini-3.5-flash",
          contents: reviewPrompt,
          config: { responseMimeType: "application/json" }
      });

      const result = parseGeminiJSON(response.text || "");
      res.json({ result });
    } catch(err: any) {
      console.error(err);
      res.status(500).json({ error: "Failed to run automated review.", details: err.message });
    }
  });

  app.post("/api/improve-paper", requireSupabaseSession, async (req, res) => {
    try {
      const { paperContent, review, topic } = req.body;
      const textToImprove = paperContent ? paperContent.substring(0, 50000) : "No content provided.";
      
      const improvePrompt = `
        You are an expert academic editor. You are provided with a drafted research paper and its peer review feedback.
        Original Topic: ${topic}
        
        Review Feedback to apply:
        ${JSON.stringify(review, null, 2)}
        
        Your task is to REWRITE and IMPROVE the research paper specifically addressing the weaknesses and actionable improvements listed in the review.
        - Preserve the original topic and structure.
        - Improve citations, literature review, methodology, datasets, baselines, and evaluation design.
        - Ensure reference consistency and academic writing quality.
        - STRICT EVIDENCE-BASED POLICY: Do NOT generate fabricated experimental results (e.g., specific AUROC, Accuracy, F1-scores) unless explicit empirical evidence is present in the Original Paper Draft. If absent, use Conceptual Research Mode terminology (e.g. "Expected Outcomes").
        - Output MUST be valid JSON conforming exactly to this structure (no markdown wrapping outsize of JSON fields):
        {
          "title": "Paper Title (string)",
          "abstract": "Abstract text (string)",
          "keywords": ["keyword1", "keyword2", "keyword3"],
          "sections": [
            {"id": "intro", "title": "1. Introduction", "content": "Markdown content..."},
            {"id": "lit", "title": "2. Literature Review", "content": "Markdown content..."},
            {"id": "gap", "title": "3. Research Gap", "content": "Markdown content..."},
            {"id": "method", "title": "4. Proposed Methodology", "content": "Markdown content..."},
            {"id": "setup", "title": "5. Experimental Setup", "content": "Markdown content..."},
            {"id": "results", "title": "6. Results & Discussion", "content": "Markdown content..."},
            {"id": "conclusion", "title": "7. Conclusion", "content": "Markdown content..."}
          ],
          "references": "Text or markdown of references properly formatted."
        }
        
        Original Paper Draft:
        ${textToImprove}
      `;

      const response = await generateWithRetry(ai, {
          model: "gemini-3.5-flash",
          contents: improvePrompt,
          config: { responseMimeType: "application/json" }
      });

      const result = parseGeminiJSON(response.text || "");
      validateEvaluationResults(result, { topic, problemStatement: textToImprove, method: textToImprove }); // Use original text as allowed inputs
      res.json({ result });
    } catch(err: any) {
      console.error(err);
      res.status(500).json({ error: "Failed to improve paper.", details: err.message });
    }
  });

  app.post("/api/generate-bibtex", requireSupabaseSession, async (req, res) => {
    try {
      const { references } = req.body;
      const prompt = `
        You are an expert academic assistant. Convert the following list of academic references into BibTeX format.
        Return ONLY the raw BibTeX strings. No markdown formatting (\`\`\`bibtex).
        
        References:
        ${JSON.stringify(references, null, 2)}
      `;

      const response = await generateWithRetry(ai, {
        model: FALLBACK_MODELS[0],
        contents: prompt
      });
      
      res.json({ result: response.text?.replace(/\`\`\`bibtex/g, '').replace(/\`\`\`/g, '').trim() });
    } catch(err: any) {
      console.error(err);
      res.status(500).json({ error: "Failed to generate BibTeX." });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
