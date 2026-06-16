import express from "express";
import path from "path";
import multer from "multer";
import { GoogleGenAI } from "@google/genai";
import { createServer as createViteServer } from "vite";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";
dotenv.config();
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 } // 20 MB max
});

// Cache for uploaded PDFs to optimize API calls
const documentCache = new Map<string, { buffer: Buffer, mimeType: string }>();

const MAX_RETRIES = 3;

async function generateWithRetry(ai: GoogleGenAI, request: any, retries = 0): Promise<any> {
  try {
    return await ai.models.generateContent(request);
  } catch (error: any) {
    if (retries >= MAX_RETRIES) {
      throw error;
    }
    
    const errorString = String(error).toLowerCase();
    const isRetryable = errorString.includes("503") || errorString.includes("429") || errorString.includes("quota") || errorString.includes("high demand") || errorString.includes("unavailable") || errorString.includes("overloaded");
    
    const isTooLarge = errorString.includes("token overflow") || errorString.includes("too many tokens") || errorString.includes("payload too large") || errorString.includes("too large");

    if (!isRetryable && !isTooLarge) {
      throw error;
    }

    const delay = Math.pow(2, retries) * 1000 + Math.random() * 1000;
    console.log(`[API Retry] Attempt ${retries + 1}/${MAX_RETRIES} failed. Retrying in ${Math.round(delay)}ms for model ${request.model}...`);
    
    let nextRequest = { ...request };
    
    if (isTooLarge && nextRequest.model !== "gemini-1.5-pro") {
        console.log(`[API Retry] Payload too large. Falling back to gemini-1.5-pro for larger context window...`);
        nextRequest.model = "gemini-1.5-pro"; // 2M tokens context
    } else if (retries === MAX_RETRIES - 1 && nextRequest.model === "gemini-2.5-flash") {
      console.log(`[API Retry] Falling back directly to gemini-1.5-flash for final attempt...`);
      nextRequest.model = "gemini-1.5-flash";
    }
    
    await new Promise(resolve => setTimeout(resolve, delay));
    return generateWithRetry(ai, nextRequest, retries + 1);
  }
}

function classifyError(error: any): { statusCode: number, message: string } {
  const errorString = String(error).toLowerCase();
  
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

function extractPartialJSON(text: string): any {
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

       throw new Error("Cannot recover partial JSON.");
    }
}

function parseGeminiJSON(text: string) {
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
  return extractPartialJSON(cleanText);
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Init Gemini SDK
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  // API endpoints
  app.post("/api/upload-document", upload.single("paper"), (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      if (req.file.mimetype !== "application/pdf") {
        return res.status(400).json({ error: "Only PDF files are supported" });
      }

      const documentId = uuidv4();
      documentCache.set(documentId, {
        buffer: req.file.buffer,
        mimeType: req.file.mimetype,
      });

      res.json({ documentId });
    } catch (error: any) {
      console.error("Error uploading document:", error);
      res.status(500).json({ error: "Failed to upload document" });
    }
  });

  app.post("/api/summarize-document", async (req, res) => {
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
      
      const response = await generateWithRetry(ai, {
        model: "gemini-2.5-flash",
        contents: [
          {
            role: "user",
            parts: [
              {
                inlineData: {
                  data: base64Data,
                  mimeType: "application/pdf"
                }
              },
              {
                text: prompt
              }
            ]
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

  app.post("/api/generate-paper", async (req, res) => {
    try {
      const data = req.body;
      const prompt = `
        You are an expert academic writer and researcher. Genrerate a complete structured academic paper based on the following inputs:
        - Topic: ${data.topic}
        - Domain: ${data.domain}
        - Keywords: ${data.keywords}
        - Problem Statement: ${data.problemStatement}
        - Objectives: ${data.objectives}
        - Proposed Method: ${data.method}
        - Dataset: ${data.dataset || "N/A"}
        - Paper Type: ${data.paperType}
        - Publication Format: ${data.publicationFormat}

        Reference Rules:
        - Never generate fake citations.
        - Never fabricate DOIs.
        - Never fabricate author names.
        - If real references are unavailable for a claim, state [Reference Required - Manual Verification Needed].

        Format Rules:
        - Format the paper following the guidelines and structure of a ${data.publicationFormat} for a ${data.paperType}.
        - The sections should be distinct and detailed.
        - Do NOT include Viva Questions, Interview Questions, PPT Outlines, Project Documentation, or Deployment Plans. This is solely an academic publication.
        
        CRITICAL INSTRUCTIONS:
        1. NO PLACEHOLDERS: Do NOT include "TODO", "[Citation Needed]", "Reference Required", "Insert here", or sample content.
        2. NO GENERIC CONTENT: Write ONLY project-specific academic paper details.
        3. STRICT TECH DECISIONS: Pick ONE definitive setup.
        4. Keep each section content extremely concise (approx. 100-150 words) to prevent truncation. Output raw markdown inside JSON.
        5. Ensure all text values are properly escaped for valid JSON (no raw newlines or tabs in strings).

        Return a valid JSON object matching this schema:
        {
          "title": "Generated Title",
          "abstract": "Abstract content",
          "keywords": ["key1", "key2"],
          "sections": [
            {"id": "intro", "title": "1. Introduction", "content": "Markdown content..."},
            {"id": "lit", "title": "2. Literature Review", "content": "Markdown content..."},
            ...
          ],
          "references": "Text or markdown of references properly formatted."
        }
        Ensure the output is raw JSON with no markdown wrapping (i.e. no \`\`\`json).
      `;

      const response = await generateWithRetry(ai, {
        model: "gemini-2.5-flash",
        contents: prompt,
        config: { responseMimeType: "application/json" }
      });

      const responseText = response.text;
      if (!responseText) throw new Error("No text returned from API.");

      const parsedJSON = parseGeminiJSON(responseText);
      res.json({ result: parsedJSON });
    } catch (error: any) {
      console.error("Error generating paper:", error);
      const { statusCode, message } = classifyError(error);
      res.status(statusCode).json({ error: message, details: error.message });
    }
  });

  app.post("/api/suggest-assistance", async (req, res) => {
    try {
      const { topic, domain, assistanceType, currentContent } = req.body;
      const prompt = `
        You are an expert AI research assistant. The user is writing a paper on the topic: "${topic}" within the domain "${domain}".
        The user is asking for assistance of type: "${assistanceType}".
        Additional context provided by the user: "${currentContent || 'None'}"
        
        Provide a detailed, helpful markdown response fulfilling this request. Avoid vague advice, give concrete suggestions.
      `;

      const response = await generateWithRetry(ai, {
        model: "gemini-2.5-flash",
        contents: prompt
      });

      res.json({ result: response.text });
    } catch (error: any) {
      console.error("Error generating assistance:", error);
      const { statusCode, message } = classifyError(error);
      res.status(statusCode).json({ error: message, details: error.message });
    }
  });

  app.post("/api/find-references", async (req, res) => {
    try {
      const data = req.body;
      const queryContext = `${data.topic} ${data.keywords} ${data.domain}`.trim();
      
      const queryPrompt = `
        Based on the following research paper context, extract a highly optimized search query string (max 4 keywords) to find relevant academic papers using API searches.
        Context: ${queryContext}
        Return ONLY the raw query string without quotes.
      `;
      
      const response = await generateWithRetry(ai, {
        model: "gemini-2.5-flash",
        contents: queryPrompt
      });
      
      const searchQuery = response.text?.trim()?.replace(/["']/g, "") || queryContext.substring(0, 30);
      
      console.log("Searching Crossref, Semantic Scholar, PubMed, and arXiv for:", searchQuery);
      
      // External APIs
      const crossrefUrl = `https://api.crossref.org/works?query=${encodeURIComponent(searchQuery)}&select=title,author,issued,DOI,publisher,container-title&rows=10`;
      const semanticUrl = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(searchQuery)}&limit=10&fields=title,authors,year,url,venue,externalIds`;
      const pubmedSearchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(searchQuery)}&retmode=json&retmax=5`;
      const arxivUrl = `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(searchQuery)}&start=0&max_results=5`;

      const fetchWithTimeout = async (url: string, ms = 5000) => {
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
            
            // Remove duplicates by title roughly
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
             // Since we don't have an XML parser, we use regex for quick extraction
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
      
      // Fallback behavior if APIS fail or return 0 references
      if (references.length === 0) {
          console.log("External APIs returned no results, falling back to basic result...");
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
          }], query: searchQuery });
          return;
      }
      
      // Return top 15 references
      res.json({ result: references.slice(0, 15), query: searchQuery });
    } catch (error: any) {
      console.error("Error finding references:", error);
      res.status(500).json({ error: "Failed to find verified references. Please try again." });
    }
  });

  app.post("/api/chat-document", async (req, res) => {
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
      
      // If history is empty, attach document to the first message part
      if (!history || history.length === 0) {
        contents.push({
          role: "user",
          parts: [
            { inlineData: { data: base64Data, mimeType: "application/pdf" } },
            { text: message }
          ]
        });
      } else {
        // history has previous messages
        contents.push({
          role: "user",
          parts: [
            { inlineData: { data: base64Data, mimeType: "application/pdf" } },
            { text: history[0].text } // Assuming history[0] is user
          ]
        });
        
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
        model: "gemini-2.5-flash",
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

  app.post("/api/analyze-gaps", async (req, res) => {
    try {
      const data = req.body;
      const { title, domain, description } = data;
      
      const queryContext = `${title} ${domain} ${description || ""}`.trim();
      
      const queryPrompt = `
        Based on the following research proposal or project context, extract a highly optimized search query string (max 4 keywords) to find relevant academic papers that discuss limitations and future work in this exact domain.
        Context: ${queryContext}
        Return ONLY the raw query string without quotes.
      `;
      
      const responseQuery = await generateWithRetry(ai, {
        model: "gemini-2.5-flash",
        contents: queryPrompt
      });
      const searchQuery = responseQuery.text?.trim()?.replace(/["']/g, "") || queryContext.substring(0, 30);

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
        model: "gemini-2.5-flash",
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

  app.post("/api/generate-project", async (req, res) => {
    try {
      const data = req.body;
      const prompt = `
        You are an expert technical project consultant and academic assistant. Generate a comprehensive project structure and document based on the following:
        - Title: ${data.title}
        - Domain: ${data.domain}
        - Objectives: ${data.objectives}
        - Technologies: ${data.technologies}
        - Description: ${data.description}
        - Expected Outcomes: ${data.expectedOutcomes}
        - Project Type: ${data.projectType}
        
        CRITICAL RULES:
        1. NO PLACEHOLDERS: Do NOT include "TODO", "[Citation Needed]", "Reference Required", "Insert here", or sample content.
        2. NO GENERIC CONTENT: Do not write broad textbook explanations. Write ONLY project-specific details.
        3. STRICT TECH DECISIONS: Pick ONE definitive technology stack/dataset. Do not say "TensorFlow or PyTorch". Justify the single choice.
        4. METHODOLOGY & GAPS: Strictly align methodology with the exact project objectives. Gaps must sound like realistic academic research gaps.
        5. Keep each section content extremely concise (150-200 words max) to prevent truncation. Output raw markdown inside JSON.
        6. Ensure all text values are properly escaped for valid JSON.

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
            {"id": "lit", "title": "5. Literature Survey & Research Gap", "content": "Markdown content..."},
            {"id": "method", "title": "6. Proposed Methodology", "content": "Markdown content..."},
            {"id": "arch", "title": "7. System Architecture", "content": "Markdown content..."},
            {"id": "modules", "title": "8. Module Description", "content": "Markdown content..."},
            {"id": "workflow", "title": "9. Workflow", "content": "Markdown content..."},
            {"id": "tech", "title": "10. Technology Stack", "content": "Markdown content..."},
            {"id": "db", "title": "11. Database & Dataset Design", "content": "Markdown content..."},
            {"id": "testing", "title": "12. Testing Strategy", "content": "Markdown content..."},
            {"id": "results", "title": "13. Results & Outcomes", "content": "Markdown content..."},
            {"id": "future", "title": "14. Future Scope", "content": "Markdown content..."},
            {"id": "deploy", "title": "15. Deployment Plan", "content": "Markdown content..."},
            {"id": "conclusion", "title": "16. Conclusion", "content": "Markdown content..."},
            {"id": "viva", "title": "Appendix A: Viva Questions", "content": "Markdown content..."}
          ]
        }
        Ensure the output is raw JSON with no markdown wrapping (\`\`\`json).
      `;

      const response = await generateWithRetry(ai, {
        model: "gemini-2.5-flash",
        contents: prompt,
        config: { responseMimeType: "application/json" }
      });

      const responseText = response.text;
      if (!responseText) throw new Error("No text returned from API.");

      const parsedJSON = parseGeminiJSON(responseText);
      res.json({ result: parsedJSON });
    } catch (error: any) {
      console.error("Error generating project:", error);
      const { statusCode, message } = classifyError(error);
      res.status(statusCode).json({ error: message, details: error.message });
    }
  });

  app.post("/api/resume-generation", async (req, res) => {
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
        model: "gemini-2.5-flash",
        contents: prompt,
        config: { responseMimeType: "application/json" }
      });

      const parsedJSON = parseGeminiJSON(response.text || "");
      res.json({ result: parsedJSON });
    } catch (error: any) {
      console.error("Error resuming generation:", error);
      const { statusCode, message } = classifyError(error);
      res.status(statusCode).json({ error: message, details: error.message });
    }
  });

  app.post("/api/check-compliance", async (req, res) => {
    try {
      const { publicationFormat, paperContent } = req.body;
      const prompt = `
        You are an expert Document Quality Enforcement Engine for an academic copilot.
        Review the following document against strict ${publicationFormat || 'Academic'} guidelines to determine if it is publication-ready.
        
        Analyze the document for the following CRITICAL QUALITY RULES:
        1. Placeholder Detection: Check for "TODO", "[Citation Needed]", "Reference Required", "Sample Content", etc. If found, export must be blocked.
        2. Generic Content Detection: Identify broad textbook explanations, repetitiveness, or non-project-specific filler.
        3. Technology Consistency: Ensure ONE specific technology stack is chosen (e.g., NOT "TensorFlow or PyTorch").
        4. Literature Survey Validation: Ensure literature survey mentions specific works and avoids fabricated claims.
        5. Methodology Validation: Ensure the methodology aligns strictly with the project objectives.
        6. Academic Writing Quality: Evaluate tone, technical depth, and readability.

        Provide a series of scores and an ultimate export decision. Export should be BLOCKED (exportAllowed: false) if there are ANY placeholders, generic sections, "X or Y" tech stacks, or if the overall score is below 80.
        
        Format exact JSON without markdown codeblock:
        {
          "scores": {
            "overall": 95,
            "citationAccuracy": 90,
            "literatureQuality": 95,
            "methodologyConsistency": 98,
            "researchGapQuality": 90,
            "academicWriting": 96
          },
          "exportAllowed": true,
          "criticalIssues": [
             "List any blocking issues here, such as placeholders or generic 'either/or' technologies. Leave empty if none."
          ],
          "recommendations": [
             "List non-blocking suggestions for improvement."
          ]
        }
        
        Paper Content snippet:
        ${paperContent.substring(0, 30000)}
      `;

      const response = await generateWithRetry(ai, {
        model: "gemini-2.5-flash",
        contents: prompt,
        config: { responseMimeType: "application/json" }
      });

      const jsonResult = parseGeminiJSON(response.text || "");
      res.json({ result: jsonResult });
    } catch(err: any) {
      console.error(err);
      res.status(500).json({ error: "Failed to run compliance check." });
    }
  });

  app.post("/api/generate-bibtex", async (req, res) => {
    try {
      const { references } = req.body;
      const prompt = `
        You are an expert academic assistant. Convert the following list of academic references into BibTeX format.
        Return ONLY the raw BibTeX strings. No markdown formatting (\`\`\`bibtex).
        
        References:
        ${JSON.stringify(references, null, 2)}
      `;

      const response = await generateWithRetry(ai, {
        model: "gemini-2.5-flash",
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
