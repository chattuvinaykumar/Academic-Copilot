import express from "express";
import path from "path";
import multer from "multer";
import { GoogleGenAI } from "@google/genai";
import { createServer as createViteServer } from "vite";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";

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
    
    if (!isRetryable) {
      throw error;
    }

    const delay = Math.pow(2, retries) * 1000 + Math.random() * 1000;
    console.log(`[API Retry] Attempt ${retries + 1}/${MAX_RETRIES} failed. Retrying in ${Math.round(delay)}ms for model ${request.model}...`);
    
    let nextRequest = { ...request };
    if (retries === MAX_RETRIES - 1 && nextRequest.model === "gemini-2.5-flash") {
      console.log(`[API Retry] Falling back directly to gemini-1.5-flash for final attempt...`);
      nextRequest.model = "gemini-1.5-flash";
    }
    
    await new Promise(resolve => setTimeout(resolve, delay));
    return generateWithRetry(ai, nextRequest, retries + 1);
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
  return JSON.parse(cleanText);
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
          "keyPoints": ["Point 1", "Point 2", "Point 3", ...],
          "keywords": ["Keyword1", "Keyword2", ...],
          "title": "The exact title of the paper",
          "methodologySummary": "A concise summary of the methodology used.",
          "resultsSummary": "A concise summary of the key findings and results.",
          "futureWorkSummary": "A concise summary of the future work or open questions highlighted in the paper."
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
      res.status(500).json({ error: "We are experiencing high traffic processing documents. Please try again in a moment." });
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
        1. Keep each section content extremely concise (approx. 100-150 words) to prevent the JSON response from exceeding output limits and being truncated. If it must be longer, focus only on the absolute most important points.
        2. Ensure all text values are properly escaped for valid JSON (no raw newlines or tabs in strings).

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
      res.status(500).json({ error: "We are experiencing high traffic generating papers. Please try again in a moment." });
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
      res.status(500).json({ error: "Failed to load assistance at this time. Please try again." });
    }
  });

  app.post("/api/find-references", async (req, res) => {
    try {
      const data = req.body;
      const queryContext = `${data.topic} ${data.keywords} ${data.domain}`.trim();
      
      const queryPrompt = `
        Based on the following research paper context, extract a highly optimized search query string (max 4 keywords) to find relevant academic papers on Crossref.
        Context: ${queryContext}
        Return ONLY the raw query string without quotes.
      `;
      
      const response = await generateWithRetry(ai, {
        model: "gemini-2.5-flash",
        contents: queryPrompt
      });
      
      const searchQuery = response.text?.trim()?.replace(/["']/g, "") || queryContext.substring(0, 30);
      
      console.log("Searching Crossref for:", searchQuery);
      
      // Use crossref API
      const crossrefUrl = `https://api.crossref.org/works?query=${encodeURIComponent(searchQuery)}&select=title,author,issued,DOI,publisher,container-title&rows=15`;
      
      const crossrefRes = await fetch(crossrefUrl);
      if (!crossrefRes.ok) {
         throw new Error("Failed to fetch from Crossref");
      }
      const crossrefData = await crossrefRes.json();
      const items = crossrefData?.message?.items || [];
      
      const validItems = items.filter((item: any) => item.title && item.author && item.DOI);
      
      const references = validItems.map((item: any) => {
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
          publisher: item.publisher || "",
          container: item["container-title"] ? item["container-title"][0] : "",
          url: `https://doi.org/${item.DOI}`
        };
      });
      
      res.json({ result: references.slice(0, 10), query: searchQuery });
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
      res.status(500).json({ error: "We are experiencing high traffic with paper chat. Please try again in a moment." });
    }
  });

  app.post("/api/generate-project", async (req, res) => {
    try {
      const data = req.body;
      const prompt = `
        You are an expert technical project consultant. Generate a comprehensive project structure and document based on the following:
        - Title: ${data.title}
        - Domain: ${data.domain}
        - Objectives: ${data.objectives}
        - Technologies: ${data.technologies}
        - Description: ${data.description}
        - Expected Outcomes: ${data.expectedOutcomes}
        - Project Type: ${data.projectType}
        
        CRITICAL INSTRUCTIONS:
        1. Keep each section content concise (approx. 100-150 words) to prevent the JSON response from exceeding output limits and being truncated.
        2. Ensure all text values are properly escaped for valid JSON (no raw newlines or tabs in strings).

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
            {"id": "solution", "title": "5. Proposed Solution", "content": "Markdown content..."},
            {"id": "arch", "title": "6. System Architecture", "content": "Markdown content..."},
            {"id": "modules", "title": "7. Module Description", "content": "Markdown content..."},
            {"id": "workflow", "title": "8. Workflow", "content": "Markdown content..."},
            {"id": "tech", "title": "9. Technology Stack", "content": "Markdown content..."},
            {"id": "db", "title": "10. Database Design", "content": "Markdown content..."},
            {"id": "testing", "title": "11. Testing Strategy", "content": "Markdown content..."},
            {"id": "results", "title": "12. Results & Outcomes", "content": "Markdown content..."},
            {"id": "future", "title": "13. Future Enhancements", "content": "Markdown content..."},
            {"id": "deploy", "title": "14. Deployment Plan", "content": "Markdown content..."},
            {"id": "conclusion", "title": "15. Conclusion", "content": "Markdown content..."},
            {"id": "ppt", "title": "Appendix A: PPT Outline", "content": "Markdown content..."},
            {"id": "viva", "title": "Appendix B: Viva / Interview Questions", "content": "Markdown content..."}
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
      res.status(500).json({ error: "We are experiencing high traffic generating projects. Please try again in a moment." });
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
