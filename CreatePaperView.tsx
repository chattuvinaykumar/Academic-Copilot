import React, { useState, useEffect, useRef } from "react";
import { PaperFormData, GeneratedPaper } from "../types";
import { motion, AnimatePresence } from "motion/react";
import { Save, FileText, Loader2, Download, Copy, RefreshCw, PenTool, Lightbulb, Search, CheckCircle, Bot, ArrowRight, CheckCircle2 } from "lucide-react";
import Markdown from "react-markdown";
import localforage from "localforage";
import { saveAs } from "file-saver";
import { Document, Paragraph, TextRun, Packer, HeadingLevel } from "docx";
import { jsPDF } from "jspdf";
import { ProgressIndicator } from "./ProgressIndicator";
import { DocumentSkeleton } from "./DocumentSkeleton";
import { Toast } from "./Toast";

interface VerifiedReference {
  title: string;
  authors: string;
  year: string;
  doi: string;
  publisher: string;
  container: string;
  url: string;
  source?: string;
  verified?: {
    doi: boolean;
    authors: boolean;
    source: boolean;
  };
}

const DEFAULT_FORM: PaperFormData = {
  topic: "",
  domain: "",
  keywords: "",
  problemStatement: "",
  objectives: "",
  method: "",
  dataset: "",
  paperType: "Research Paper",
  publicationFormat: "IEEE Conference"
};

const PAPER_TYPES = [
  "Research Paper", "Review Paper", "Survey Paper", 
  "Systematic Literature Review (SLR)", "Case Study", 
  "Technical Report", "Workshop Paper", "Short Paper"
];

const PUBLICATION_FORMATS = [
  "IEEE Conference", "IEEE Journal", "Springer Conference", "Springer Journal",
  "Elsevier Journal", "ACM Conference", "Scopus Indexed Format", 
  "Taylor & Francis", "Wiley Journal", "MDPI Journal", "Nature Style",
  "Thesis / Dissertation", "Generic Research Paper"
];

const ASSISTANCE_OPTIONS = [
  "Generate Research Gap Suggestions", "Generate Novel Research Ideas",
  "Suggest Suitable Datasets", "Suggest Evaluation Metrics",
  "Suggest Related Technologies", "Suggest Future Research Directions",
  "Generate Research Questions", "Generate Hypotheses"
];

export function CreatePaperView() {
  const [formData, setFormData] = useState<PaperFormData>(DEFAULT_FORM);
  const [loading, setLoading] = useState(false);
  const [generatingType, setGeneratingType] = useState<"draft" | "submission" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generatedPaper, setGeneratedPaper] = useState<GeneratedPaper | null>(null);
  const [assistantLoading, setAssistantLoading] = useState(false);
  const [assistantResult, setAssistantResult] = useState<string | null>(null);
  const [showToast, setShowToast] = useState(false);
  const [toastMessage, setToastMessage] = useState("Success");
  const [findingReferences, setFindingReferences] = useState(false);
  const [verifiedReferences, setVerifiedReferences] = useState<VerifiedReference[] | null>(null);
  const [citationFormat, setCitationFormat] = useState("IEEE");
  const [complianceReport, setComplianceReport] = useState<any>(null);
  const [complianceLoading, setComplianceLoading] = useState(false);
  const [regeneratingSection, setRegeneratingSection] = useState<string | null>(null);
  const [researchPlan, setResearchPlan] = useState<string | null>(null);
  const [isPlanExpanded, setIsPlanExpanded] = useState<boolean>(true);
  
  const [agentStates, setAgentStates] = useState({
    planner: "waiting",
    reference: "waiting",
    writer: "waiting",
    compliance: "waiting",
    export: "waiting"
  });
  
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadDraft();
  }, []);

  useEffect(() => {
    if (generatedPaper && contentRef.current) {
        contentRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [generatedPaper]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleGenerate = async (draftMode: "draft" | "submission") => {
    if (!formData.topic || !formData.domain) {
      setError("Topic and Domain are required.");
      return;
    }
    setLoading(true);
    setGeneratingType(draftMode);
    setError(null);
    setComplianceReport(null);
    setVerifiedReferences(null);
    setResearchPlan(null);
    setIsPlanExpanded(true);

    setAgentStates({ planner: "running", reference: "waiting", writer: "waiting", compliance: "waiting", export: "waiting" });
    
    try {
      const planReq = await fetch("/api/suggest-assistance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: formData.topic,
          domain: formData.domain,
          assistanceType: "Generate a comprehensive Research Plan.",
          currentContent: `Please include the following sections exactly formatted as Headings:\n- Research Objectives\n- Research Questions\n- Keywords\n- Suggested Methodology\n- Paper Outline\n\nBased on details:\nProblem: ${formData.problemStatement}\nObjectives: ${formData.objectives}\nMethod: ${formData.method}`
        })
      });
      if (planReq.ok) {
        const planData = await planReq.json();
        setResearchPlan(planData.result);
      }
    } catch (err) {
      console.error("Research Planner failed", err);
    }
    
    setAgentStates(prev => ({ ...prev, planner: "complete", reference: "running" }));

    const agentInterval = setInterval(() => {
        setAgentStates(prev => {
            if (prev.reference === "running") return { ...prev, reference: "complete", writer: "running" };
            return prev;
        });
    }, 4000);

    try {
      const response = await fetch("/api/generate-paper", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...formData, draftMode })
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Generation failed.");
      }
      const data = await response.json();
      
      const paperWithMode: GeneratedPaper = {
        ...data.result,
        mode: draftMode
      };
      setGeneratedPaper(paperWithMode);
      
      if (paperWithMode.partial) {
          setToastMessage("Paper generated partially. You may regenerate or continue.");
      } else {
          setToastMessage(draftMode === "draft" ? "Draft generated successfully!" : "Paper generated. Running compliance checks...");
      }
      
      setShowToast(true);
      saveDraft(formData, paperWithMode);
      
      if (draftMode === "submission") {
        // Run asynchronously after generation without blocking UI
        runComplianceAudit(paperWithMode);
      } else {
        // Mock a friendly compliance report for draft mode so they aren't blocked on exports and have zero friction
        setComplianceReport({
            scores: {
                overall: 88,
                citationAccuracy: 85,
                literatureQuality: 85,
                methodologyConsistency: 90,
                academicWriting: 90
            },
            exportAllowed: true,
            criticalIssues: [],
            recommendations: [
                "Draft generated successfully! This is a working paper draft.",
                "To perform structural format checks (IEEE, Nature, etc.) and reference matching, use the 'Generate Submission Draft' feature."
            ]
        });
      }
    } catch (err: any) {
      setError(err.message || "An unexpected error occurred.");
    } finally {
      clearInterval(agentInterval);
      setAgentStates(prev => ({ ...prev, planner: "complete", reference: "complete", writer: "complete" }));
      setLoading(false);
      setGeneratingType(null);
    }
  };

  const runComplianceAudit = async (paperOutput: any) => {
      setComplianceLoading(true);
      setAgentStates(prev => ({ ...prev, compliance: "running" }));
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

      try {
        const fullText = paperOutput.title + "\n\nAbstract\n" + paperOutput.abstract + "\n\n" + paperOutput.sections.map((s: any) => s.title + "\n" + s.content).join("\n\n") + "\n\nReferences\n" + paperOutput.references;
        const compResponse = await fetch("/api/check-compliance", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ publicationFormat: formData.publicationFormat, paperContent: fullText }),
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        const compData = await compResponse.json();
        if (!compResponse.ok) {
            throw new Error(compData.details || compData.error || "Compliance API error");
        }
        setComplianceReport(compData.result);
      } catch (err: any) {
        clearTimeout(timeoutId);
        console.error("Compliance calculation failed:", err);
        
        let issueMessage = "An unexpected error occurred.";
        if (err.name === 'AbortError' || err.message.includes('abort')) {
             issueMessage = "Validation Timed Out. The server took too long to respond.";
        } else if (err.message.includes('Failed to fetch')) {
             issueMessage = "Network Failure. Please check your connection.";
        } else if (err.message.toLowerCase().includes('parse')) {
             issueMessage = "Parsing Failure. Received invalid data from the server.";
        } else {
             issueMessage = `Backend Exception: ${err.message}`;
        }
        
        setComplianceReport({
            scores: {} as any,
            exportAllowed: true, // Fail-open on timeout or allow retry
            criticalIssues: [issueMessage],
            recommendations: ["Compliance check couldn't be completed. You can export the paper, but please review it manually. Click 'Run Compliance Check' to retry."]
        });
      } finally {
        setAgentStates(prev => ({ ...prev, compliance: "complete" }));
        setComplianceLoading(false);
      }
  };

  const handleResumeGeneration = async () => {
    if (!generatedPaper) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/resume-generation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "research paper",
          existingContent: generatedPaper,
          promptData: formData
        })
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Failed to resume generation.");
      }
      const data = await response.json();
      
      setGeneratedPaper(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          sections: [...prev.sections, ...(data.result.sections || [])],
          references: data.result.references && data.result.references !== "Text or markdown of references properly formatted." 
            ? data.result.references 
            : prev.references,
          partial: data.result.partial || false
        };
      });

      if (!data.result.partial) {
         setToastMessage("Paper completely generated!");
         setShowToast(true);
      }
    } catch (err: any) {
      setError(err.message || "An unexpected error occurred.");
    } finally {
      setLoading(false);
    }
  };

  const handleRunCompliance = async () => {
    if (!generatedPaper) return;
    await runComplianceAudit(generatedPaper);
  };

  const handleReviewPaper = async () => {
    if (!generatedPaper) return;
    setLoading(true);
    try {
      const fullText = generatedPaper.title + "\n\nAbstract\n" + generatedPaper.abstract + "\n\n" + generatedPaper.sections.map((s: any) => s.title + "\n" + s.content).join("\n\n") + "\n\nReferences\n" + generatedPaper.references;
      const response = await fetch("/api/review-paper", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paperContent: fullText })
      });
      if (!response.ok) throw new Error("Failed to review paper");
      const data = await response.json();
      
      const newPaper = { ...generatedPaper, review: data.result, version: generatedPaper.version || 1 };
      setGeneratedPaper(newPaper);
      saveDraft(formData, newPaper);
      setToastMessage("Automated peer review completed.");
      setShowToast(true);
    } catch (err: any) {
      alert("Error reviewing paper: " + err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleImprovePaper = async () => {
    if (!generatedPaper || !generatedPaper.review) return;
    setLoading(true);
    try {
      const fullText = generatedPaper.title + "\n\nAbstract\n" + generatedPaper.abstract + "\n\n" + generatedPaper.sections.map((s: any) => s.title + "\n" + s.content).join("\n\n") + "\n\nReferences\n" + generatedPaper.references;
      const response = await fetch("/api/improve-paper", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
           paperContent: fullText, 
           review: generatedPaper.review, 
           topic: formData.topic 
        })
      });
      if (!response.ok) throw new Error("Failed to improve paper");
      const data = await response.json();
      
      const improvedPaper: GeneratedPaper = { 
         ...data.result, 
         mode: generatedPaper.mode,
         version: (generatedPaper.version || 1) + 1,
         previousVersion: generatedPaper,
         review: undefined // clear review for the new version
      };
      
      setGeneratedPaper(improvedPaper);
      saveDraft(formData, improvedPaper);
      setToastMessage("Paper improved successfully based on review feedback.");
      setShowToast(true);
    } catch (err: any) {
      alert("Error improving paper: " + err.message);
    } finally {
      setLoading(false);
    }
  };

  const switchVersion = () => {
     if (!generatedPaper || !generatedPaper.previousVersion) return;
     const prev = generatedPaper.previousVersion;
     
     // swap them
     const newPaper = {
         ...prev,
         previousVersion: {
             ...generatedPaper,
             previousVersion: undefined
         }
     };
     setGeneratedPaper(newPaper);
     saveDraft(formData, newPaper);
  };

  const handleRegenerateSection = async (sectionId: string, sectionTitle: string, currentContent: string) => {
    if (!generatedPaper) return;
    setRegeneratingSection(sectionId);
    try {
      const paperContext = generatedPaper.title + " | " + generatedPaper.abstract;
      const response = await fetch("/api/generate-section", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: formData.topic, sectionTitle, currentContent, paperContext })
      });
      if (!response.ok) throw new Error("Section regeneration failed");
      const data = await response.json();
      
      let updatedPaper = { ...generatedPaper };
      if (sectionId === "title") {
          updatedPaper.title = data.result.replace(/#/g, '').replace(/\*/g, '').trim();
      } else if (sectionId === "abstract") {
          updatedPaper.abstract = data.result;
      } else if (sectionId === "keywords") {
          updatedPaper.keywords = data.result.replace(/#/g, '').split(",").map((k: string) => k.trim());
      } else {
          updatedPaper.sections = generatedPaper.sections.map(s => s.id === sectionId ? { ...s, content: data.result } : s);
      }
      
      setGeneratedPaper(updatedPaper);
      saveDraft(formData, updatedPaper);
      setToastMessage(`Section "${sectionTitle}" regenerated!`);
      setShowToast(true);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setRegeneratingSection(null);
    }
  };

  const askAssistant = async (type: string) => {
    setAssistantLoading(true);
    setAssistantResult(null);
    try {
      const response = await fetch("/api/suggest-assistance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: formData.topic,
          domain: formData.domain,
          assistanceType: type,
          currentContent: JSON.stringify(formData)
        })
      });
      if (!response.ok) {
        throw new Error("Assistant request failed");
      }
      const data = await response.json();
      setAssistantResult(data.result);
    } catch (err: any) {
      alert("Error getting assistance: " + err.message);
    } finally {
      setAssistantLoading(false);
    }
  };

  const saveDraft = async (form = formData, paper = generatedPaper) => {
    await localforage.setItem("paper_draft", { form, paper });
    alert("Draft saved!");
  };

  const loadDraft = async () => {
    const draft: any = await localforage.getItem("paper_draft");
    if (draft && draft.form) {
      setFormData(draft.form);
      if (draft.paper) setGeneratedPaper(draft.paper);
    }
  };

  const clearDraft = async () => {
    await localforage.removeItem("paper_draft");
    setFormData(DEFAULT_FORM);
    setGeneratedPaper(null);
    setVerifiedReferences(null);
  };

  const handleFindReferences = async () => {
    if (!formData.topic) return;
    setFindingReferences(true);
    try {
      const response = await fetch("/api/find-references", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData)
      });
      if (!response.ok) throw new Error("Failed to find references");
      const data = await response.json();
      setVerifiedReferences(data.result);
    } catch (err: any) {
       alert(err.message);
    } finally {
      setFindingReferences(false);
    }
  };

  const insertReferences = () => {
     if (!verifiedReferences || !generatedPaper) return;
     let formatted = "";
     verifiedReferences.forEach((r, i) => {
         if (citationFormat === "APA") {
           formatted += `${r.authors} (${r.year}). ${r.title}. *${r.container || r.publisher}*. DOI: [${r.doi}](${r.url})\n\n`;
         } else if (citationFormat === "MLA") {
           formatted += `${r.authors}. "${r.title}." *${r.container || r.publisher}*, ${r.year}. DOI: [${r.doi}](${r.url})\n\n`;
         } else if (citationFormat === "Chicago") {
           formatted += `${r.authors}. "${r.title}." *${r.container || r.publisher}* (${r.year}). DOI: [${r.doi}](${r.url})\n\n`;
         } else { // IEEE, Springer, ACM
           formatted += `[${i+1}] ${r.authors}, "${r.title}," *${r.container || r.publisher}*, ${r.year}. DOI: [${r.doi}](${r.url})\n\n`;
         }
     });
     
     const newPaper = {
        ...generatedPaper,
        references: formatted.trim()
     };
     setGeneratedPaper(newPaper);
     saveDraft(formData, newPaper);
     setToastMessage("References inserted successfully!");
     setShowToast(true);
  };

  const getWordCount = (text: string) => {
    return text.trim().split(/\s+/).filter(w => w.length > 0).length;
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    alert("Copied to clipboard!");
  };

  const downloadDocx = async () => {
    if (!generatedPaper) return;
    setToastMessage("Generating DOCX...");
    setShowToast(true);
    setAgentStates(prev => ({ ...prev, export: "running" }));
    
    try {
      const children: any[] = [];
      
      // Add Title
      children.push(new Paragraph({
          text: generatedPaper.title || "Untitled Paper",
          heading: HeadingLevel.TITLE,
          spacing: { after: 400 }
      }));
      
      // Abstract
      if (generatedPaper.abstract) {
          children.push(new Paragraph({ text: "Abstract", heading: HeadingLevel.HEADING_1 }));
          children.push(new Paragraph({ text: generatedPaper.abstract, spacing: { after: 200 } }));
      }
      
      // Keywords
      if (generatedPaper.keywords && generatedPaper.keywords.length > 0) {
          children.push(new Paragraph({ text: "Keywords: " + generatedPaper.keywords.join(", "), spacing: { after: 300 } }));
      }
      
      // Sections
      if (generatedPaper.sections) {
          generatedPaper.sections.forEach(sec => {
              if (!sec) return;
              children.push(new Paragraph({ text: sec.title || "Untitled Section", heading: HeadingLevel.HEADING_1 }));
              // simple text mapping
              children.push(new Paragraph({ text: (sec.content || "").replace(/[*#`]/g, ""), spacing: { after: 200 } }));
          });
      }
      
      // References
      if (generatedPaper.references) {
          children.push(new Paragraph({ text: "References", heading: HeadingLevel.HEADING_1 }));
          children.push(new Paragraph({ text: generatedPaper.references.replace(/[*#`]/g, "") }));
      }

      const doc = new Document({
          creator: "Academic Copilot",
          title: generatedPaper.title || "Research Paper",
          description: "Generated Research Paper",
          sections: [{ children }]
      });

      const blob = await Packer.toBlob(doc);
      saveAs(blob, "Research_Paper.docx");
      
      setToastMessage("Export Successful: DOCX downloaded.");
      setShowToast(true);
      console.log("Export started and completed: DOCX");
    } catch(err: any) {
      console.error("Docx generation error", err);
      setToastMessage(`Export Failed: ${err.message || 'Unknown error during DOCX generation'}`);
      setShowToast(true);
    } finally {
      setAgentStates(prev => ({ ...prev, export: "complete" }));
    }
  };

  const downloadPDF = () => {
    if (!generatedPaper) return;
    setToastMessage("Generating PDF...");
    setShowToast(true);
    setAgentStates(prev => ({ ...prev, export: "running" }));
    
    try {
      const doc = new jsPDF();
      let y = 10;
      const margin = 10;
      const pageHeight = doc.internal.pageSize.height;
      
      const addText = (text: string, size: number, isBold: boolean = false) => {
        if (!text) return;
        doc.setFontSize(size);
        if (isBold) {
            doc.setFont("helvetica", "bold");
        } else {
            doc.setFont("helvetica", "normal");
        }
        const splitText = doc.splitTextToSize(text, 190);
        for (let i=0; i<splitText.length; i++) {
            if (y > pageHeight - margin) {
                doc.addPage();
                y = 10;
            }
            doc.text(splitText[i], margin, y);
            y += 6;
        }
        y += 4;
      };
      
      addText(generatedPaper.title, 16, true);
      
      if (generatedPaper.abstract) {
          addText("Abstract", 14, true);
          addText(generatedPaper.abstract, 12);
      }
      
      if (generatedPaper.keywords && generatedPaper.keywords.length > 0) {
          addText("Keywords: " + generatedPaper.keywords.join(", "), 12);
      }
      
      if (generatedPaper.sections) {
          generatedPaper.sections.forEach(sec => {
              if (!sec) return;
              addText(sec.title, 14, true);
              addText((sec.content || "").replace(/[*#`]/g, ""), 12);
          });
      }
      
      if (generatedPaper.references) {
          addText("References", 14, true);
          addText(generatedPaper.references.replace(/[*#`]/g, ""), 10);
      }
      
      doc.save("Research_Paper.pdf");
      
      setToastMessage("Export Successful: PDF downloaded.");
      setShowToast(true);
      console.log("Export started and completed: PDF");
    } catch (err: any) {
      console.error("PDF generation error", err);
      setToastMessage(`Export Failed: ${err.message || 'Unknown error during PDF generation'}`);
      setShowToast(true);
    } finally {
      setAgentStates(prev => ({ ...prev, export: "complete" }));
    }
  };

  const downloadLatex = () => {
      if (!generatedPaper) return;
      setAgentStates(prev => ({ ...prev, export: "running" }));
      let tex = `\\documentclass{article}
\\title{${generatedPaper.title.replace(/&/g, '\\&')}}
\\begin{document}
\\maketitle
\\begin{abstract}
${generatedPaper.abstract.replace(/&/g, '\\&')}
\\end{abstract}
\\textbf{Keywords:} ${generatedPaper.keywords.join(", ")}

`;
      generatedPaper.sections.forEach(sec => {
          tex += `\\section*{${sec.title.replace(/&/g, '\\&')}}
${sec.content.replace(/&/g, '\\&').replace(/#/g, '')}
`;
      });
      
      tex += `\\section*{References}
${generatedPaper.references.replace(/&/g, '\\&')}
\\end{document}`;

      const blob = new Blob([tex], { type: "text/plain;charset=utf-8" });
      saveAs(blob, "Research_Paper.tex");
      setAgentStates(prev => ({ ...prev, export: "complete" }));
  };

  const downloadBibtex = async () => {
      const referencesToUse = (verifiedReferences && verifiedReferences.length > 0) 
        ? verifiedReferences 
        : generatedPaper?.references;
        
      if (!referencesToUse) {
          alert("No references found to generate BibTeX.");
          return;
      }
      setToastMessage("Generating BibTeX...");
      setShowToast(true);
      setAgentStates(prev => ({ ...prev, export: "running" }));
      try {
          const response = await fetch("/api/generate-bibtex", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ references: referencesToUse })
          });
          if (!response.ok) throw new Error("Failed to generate BibTeX");
          const data = await response.json();
          const blob = new Blob([data.result], { type: "text/plain;charset=utf-8" });
          saveAs(blob, "references.bib");
      } catch (err: any) {
          alert("Error generating BibTeX: " + err.message);
      } finally {
          setAgentStates(prev => ({ ...prev, export: "complete" }));
      }
  };

  return (
    <div className="flex flex-col lg:flex-row gap-8">
      {/* Editor Panel */}
      <div className="w-full lg:w-1/3 bg-white p-6 rounded-2xl shadow-sm border border-gray-100 flex flex-col h-[calc(100vh-10rem)] overflow-y-auto">
        <h3 className="text-xl font-bold text-gray-900 mb-6 flex items-center">
          <PenTool className="w-5 h-5 mr-2 text-blue-600" />
          Paper Configuration
        </h3>
        
        <div className="space-y-4 flex-1">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Research Topic *</label>
            <input type="text" name="topic" value={formData.topic} onChange={handleChange} className="w-full px-3 py-2 border border-gray-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500" placeholder="e.g., Quantum Machine Learning" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Research Domain *</label>
            <input type="text" name="domain" value={formData.domain} onChange={handleChange} className="w-full px-3 py-2 border border-gray-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500" placeholder="e.g., Computer Science, Robotics" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Keywords</label>
            <input type="text" name="keywords" value={formData.keywords} onChange={handleChange} className="w-full px-3 py-2 border border-gray-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500" placeholder="Comma separated..." />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Problem Statement</label>
            <textarea name="problemStatement" value={formData.problemStatement} onChange={handleChange} rows={2} className="w-full px-3 py-2 border border-gray-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Objectives</label>
            <textarea name="objectives" value={formData.objectives} onChange={handleChange} rows={2} className="w-full px-3 py-2 border border-gray-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Proposed Method</label>
            <textarea name="method" value={formData.method} onChange={handleChange} rows={2} className="w-full px-3 py-2 border border-gray-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
           <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Dataset Information (Optional)</label>
            <input type="text" name="dataset" value={formData.dataset} onChange={handleChange} className="w-full px-3 py-2 border border-gray-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          
          <div className="grid grid-cols-2 gap-4">
            <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Paper Type</label>
                <select name="paperType" value={formData.paperType} onChange={handleChange} className="w-full px-3 py-2 border border-gray-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500">
                    {PAPER_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
            </div>
            <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Format</label>
                <select name="publicationFormat" value={formData.publicationFormat} onChange={handleChange} className="w-full px-3 py-2 border border-gray-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500">
                    {PUBLICATION_FORMATS.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
            </div>
          </div>
        </div>

        {error && <div className="mt-4 p-3 bg-red-50 text-red-600 text-sm rounded-lg">{error}</div>}

        <div className="mt-6 flex flex-col gap-2">
            <button onClick={() => handleGenerate("draft")} disabled={loading} className="w-full flex items-center justify-center space-x-2 bg-gray-950 hover:bg-gray-900 text-white py-3 rounded-lg font-medium transition-colors disabled:opacity-70 cursor-pointer">
                {loading && generatingType === "draft" ? <Loader2 className="w-5 h-5 animate-spin text-amber-400" /> : <FileText className="w-5 h-5 text-amber-500" />}
                <span>Generate Draft</span>
            </button>
            <button onClick={() => handleGenerate("submission")} disabled={loading} className="w-full flex items-center justify-center space-x-2 bg-blue-600 hover:bg-blue-700 text-white py-3 rounded-lg font-medium transition-colors disabled:opacity-70 cursor-pointer">
                {loading && generatingType === "submission" ? <Loader2 className="w-5 h-5 animate-spin text-white" /> : <FileText className="w-5 h-5 text-white" />}
                <span>Generate Submission Draft</span>
            </button>
            <div className="flex gap-2">
                <button onClick={() => saveDraft()} className="flex-1 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50 flex items-center justify-center">
                    <Save className="w-4 h-4 mr-2" /> Save Draft
                </button>
                <button onClick={clearDraft} className="flex-1 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50 flex items-center justify-center">
                    Clear form
                </button>
            </div>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="w-full lg:w-2/3 flex flex-col gap-6">

        {/* Agent Workflow */}
        {(loading || generatedPaper) && (
            <div className="bg-white p-4 rounded-2xl shadow-sm border border-gray-100 flex-shrink-0">
               <h4 className="text-sm font-bold text-gray-800 mb-4 flex items-center">
                   <Bot className="w-5 h-5 mr-2 text-indigo-600" />
                   Agent Workflow
               </h4>
               <div className="flex items-center gap-2 overflow-x-auto pb-2">
                  {[
                      { id: "planner", label: "Research Planner", desc: "Outlines structure" },
                      { id: "reference", label: "Reference Agent", desc: "Finds citations" },
                      { id: "writer", label: "Paper Writer", desc: "Drafts content" },
                      { id: "compliance", label: "Compliance Agent", desc: "Checks format" },
                      { id: "export", label: "Export Agent", desc: "Generates files" }
                  ].map((agent, i, arr) => {
                      const status = agentStates[agent.id as keyof typeof agentStates];
                      return (
                          <div key={agent.id} className="flex items-center min-w-[max-content]">
                             <div className={`flex flex-col items-center justify-center p-3 rounded-xl border w-[140px] h-[80px] text-center transition-all ${status === 'running' ? 'border-indigo-400 bg-indigo-50 shadow-sm' : status === 'complete' ? 'border-emerald-300 bg-emerald-50 bg-opacity-50' : 'border-gray-200 bg-gray-50'}`}>
                                 <div className={`text-xs font-bold mb-1 ${status === 'running' ? 'text-indigo-800' : status === 'complete' ? 'text-emerald-800' : 'text-gray-600'}`}>{agent.label}</div>
                                 <div className="text-[10px] text-gray-500 mb-1.5">{agent.desc}</div>
                                 {status === "waiting" && <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Waiting</span>}
                                 {status === "running" && <span className="text-[10px] font-semibold text-indigo-600 flex items-center uppercase tracking-wide"><Loader2 className="w-3 h-3 animate-spin mr-1"/> Running</span>}
                                 {status === "complete" && <span className="text-[10px] font-bold text-emerald-600 flex items-center uppercase tracking-wide"><CheckCircle2 className="w-3 h-3 mr-1"/> Complete</span>}
                             </div>
                             {i < arr.length - 1 && <ArrowRight className="w-4 h-4 mx-2 text-gray-300 flex-shrink-0" />}
                          </div>
                      );
                  })}
               </div>
            </div>
        )}
        
        {/* Assistant Bar */}
        <div className="bg-white p-4 rounded-2xl shadow-sm border border-gray-100">
            <h4 className="text-sm font-bold text-gray-800 mb-3 flex items-center">
                <Lightbulb className="w-4 h-4 mr-2 text-yellow-500" />
                AI Research Assistant
            </h4>
            <div className="flex flex-wrap gap-2 mb-4">
                {ASSISTANCE_OPTIONS.map(opt => (
                    <button key={opt} onClick={() => askAssistant(opt)} disabled={assistantLoading} className="px-3 py-1.5 bg-blue-50 text-blue-700 hover:bg-blue-100 rounded-full text-xs font-medium transition-colors disabled:opacity-50">
                        {opt}
                    </button>
                ))}
            </div>
            {assistantLoading && <div className="text-sm text-gray-500 flex items-center"><Loader2 className="w-4 h-4 animate-spin mr-2" /> Thinking...</div>}
            {assistantResult && (
                <div className="p-4 bg-gray-50 border border-gray-200 rounded-lg text-sm prose prose-sm max-w-none relative">
                    <button onClick={() => setAssistantResult(null)} className="absolute top-2 right-2 text-gray-400 hover:text-gray-600">×</button>
                    <Markdown>{assistantResult}</Markdown>
                </div>
            )}
        </div>

        {/* Research Plan Viewer */}
        {researchPlan && (
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden flex-shrink-0">
                <button 
                  onClick={() => setIsPlanExpanded(!isPlanExpanded)} 
                  className="w-full px-6 py-4 flex items-center justify-between text-left focus:outline-none focus:ring-2 focus:ring-inset focus:ring-indigo-500 bg-gray-50 hover:bg-gray-100 transition-colors"
                >
                    <div className="flex items-center">
                        <CheckCircle2 className="w-5 h-5 mr-3 text-indigo-600" />
                        <h3 className="text-base font-bold text-gray-900">Research Plan</h3>
                    </div>
                    <span className="text-gray-500 font-medium text-xs bg-white px-3 py-1 rounded-full border shadow-sm border-gray-200">
                        {isPlanExpanded ? "Hide Plan" : "View Plan"}
                    </span>
                </button>
                <AnimatePresence>
                    {isPlanExpanded && (
                        <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: "auto", opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            className="border-t border-gray-100"
                        >
                            <div className="p-6 prose prose-indigo max-w-none text-gray-800 bg-white text-sm">
                                <Markdown>{researchPlan}</Markdown>
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
        )}

        {/* Paper Viewer */}
        <div className="flex-1 bg-white p-6 rounded-2xl shadow-sm border border-gray-100 overflow-y-auto h-[calc(100vh-20rem)] relative">
            {loading ? (
                <div className="relative w-full h-full">
                  <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-white/60 backdrop-blur-sm">
                    <ProgressIndicator messages={[
                        "Creating structure...",
                        "Generating sections...",
                        "Formatting content...",
                        "Preparing final document..."
                    ]} />
                  </div>
                  <DocumentSkeleton />
                </div>
            ) : !generatedPaper ? (
                <div className="flex items-center justify-center h-full text-gray-400">
                    <p>Fill out the configuration and generate the paper.</p>
                </div>
            ) : (
                <motion.div ref={contentRef} initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="pb-20">
                    <div className="sticky top-0 bg-white/90 backdrop-blur pb-4 border-b border-gray-100 mb-6 flex flex-wrap gap-2 justify-between items-center z-10">
                        <div className="text-xs font-semibold text-gray-500 py-1.5 flex items-center">
                            Word Count: {getWordCount(generatedPaper.title + " " + generatedPaper.abstract + " " + generatedPaper.sections.map(s => s.content).join(" ") + " " + generatedPaper.references)} | 
                            Chars: {(generatedPaper.title + " " + generatedPaper.abstract + " " + generatedPaper.sections.map(s => s.content).join(" ") + " " + generatedPaper.references).length}
                        </div>
                        {generatedPaper.mode ? (
                            <span className={`text-[10px] font-extrabold uppercase px-2.5 py-1 rounded-full border tracking-wide flex items-center ${
                                generatedPaper.mode === "draft" 
                                ? "bg-amber-50 text-amber-800 border-amber-200" 
                                : "bg-blue-50 text-blue-800 border-blue-200"
                            }`}>
                                <span className={`w-1.5 h-1.5 rounded-full mr-1.5 ${generatedPaper.mode === "draft" ? "bg-amber-500 animate-pulse" : "bg-blue-500"}`} />
                                {generatedPaper.mode === "draft" ? "Draft version" : "Submission Version"}
                            </span>
                        ) : null}
                    </div>

                    <div className="max-w-3xl mx-auto space-y-8">
                        <div className="text-center group relative">
                            <h1 className="text-3xl font-bold font-serif mb-4 text-gray-900 pr-16">{generatedPaper.title}</h1>
                            <div className="absolute top-0 right-0 flex gap-1">
                               <button onClick={() => handleRegenerateSection("title", "Title", generatedPaper.title)} disabled={regeneratingSection === "title"} className="px-2 py-1 text-xs text-blue-600 hover:text-blue-700 bg-blue-50 rounded flex items-center transition-colors disabled:opacity-50">
                                    {regeneratingSection === "title" ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <RefreshCw className="w-3 h-3 mr-1" />}
                                    AI Assist
                               </button>
                            </div>
                            <div className="flex justify-center flex-wrap items-center gap-2 mb-6 group relative">
                                {generatedPaper.keywords.map(k => (
                                    <span key={k} className="px-2 py-1 bg-gray-100 text-gray-600 rounded-md text-xs">{k}</span>
                                ))}
                                <button onClick={() => handleRegenerateSection("keywords", "Keywords", generatedPaper.keywords.join(", "))} disabled={regeneratingSection === "keywords"} className="absolute -right-16 md:-right-24 top-0 opacity-0 group-hover:opacity-100 px-2 py-1 text-xs text-blue-600 hover:text-blue-700 bg-blue-50 rounded flex items-center transition-opacity disabled:opacity-50">
                                    {regeneratingSection === "keywords" ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <RefreshCw className="w-3 h-3 mr-1" />}
                                    AI Assist
                               </button>
                            </div>
                        </div>

                        <div className="prose prose-sm md:prose-base max-w-none font-serif text-gray-800">
                            <div className="relative group">
                              <h2 className="text-xl font-bold border-b pb-2 mb-4 pr-16">Abstract</h2>
                              <div className="absolute top-0 right-0 flex gap-1">
                                 <button onClick={() => handleRegenerateSection("abstract", "Abstract", generatedPaper.abstract)} disabled={regeneratingSection === "abstract"} className="px-2 py-1 text-xs text-blue-600 hover:text-blue-700 bg-blue-50 rounded flex items-center transition-colors disabled:opacity-50">
                                      {regeneratingSection === "abstract" ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <RefreshCw className="w-3 h-3 mr-1" />}
                                      AI Assist
                                  </button>
                              </div>
                              <p>{generatedPaper.abstract}</p>
                            </div>
                            
                            {generatedPaper.sections.map(sec => (
                                <div key={sec.id} className="mt-8 relative group">
                                    <h2 className="text-xl font-bold border-b pb-2 mb-4 pr-16">{sec.title}</h2>
                                    <div className="absolute top-0 right-0 flex gap-1">
                                       <button onClick={() => handleRegenerateSection(sec.id, sec.title, sec.content)} disabled={regeneratingSection === sec.id} className="px-2 py-1 text-xs text-blue-600 hover:text-blue-700 bg-blue-50 rounded flex items-center transition-colors disabled:opacity-50">
                                            {regeneratingSection === sec.id ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <RefreshCw className="w-3 h-3 mr-1" />}
                                            AI Assist
                                        </button>
                                       <button onClick={() => copyToClipboard(sec.content)} className="p-1 px-2 text-gray-500 hover:text-gray-800 bg-gray-50 rounded text-xs flex items-center">
                                         <Copy className="w-3 h-3 mr-1" /> Copy
                                       </button>
                                    </div>
                                    <Markdown>{sec.content}</Markdown>
                                </div>
                            ))}

                            {generatedPaper.partial && (
                                <div className="mt-8 p-4 bg-orange-50 border border-orange-200 rounded-lg text-center">
                                    <h3 className="text-orange-800 font-bold mb-2">Generation Incomplete</h3>
                                    <p className="text-orange-700 text-sm mb-4">The AI model hit a token limit or timeout before finishing the document. You can resume generation to add missing sections.</p>
                                    <button onClick={handleResumeGeneration} className="px-4 py-2 bg-orange-600 hover:bg-orange-700 text-white font-medium rounded-lg shadow-sm transition-colors text-sm">
                                        Resume Missing Sections
                                    </button>
                                </div>
                            )}

                            <div className="mt-12 pt-6 border-t border-gray-300">
                                <div className="flex flex-wrap gap-4 items-center justify-between mb-4">
                                  <h2 className="text-xl font-bold">References</h2>
                                  {generatedPaper.mode !== "draft" && (
                                    <button onClick={handleFindReferences} disabled={findingReferences} className="px-4 py-2 bg-blue-50 text-blue-700 hover:bg-blue-100 rounded-lg text-sm font-medium flex items-center transition-colors disabled:opacity-50">
                                      {findingReferences ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Search className="w-4 h-4 mr-2" />}
                                      Find Verified References
                                    </button>
                                  )}
                                </div>
                                
                                {verifiedReferences && (
                                  <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="mb-6 p-4 bg-blue-50/50 border border-blue-100 rounded-xl">
                                    <div className="flex items-center justify-between mb-3">
                                      <h4 className="font-semibold text-blue-900 flex items-center text-sm">
                                        <CheckCircle className="w-4 h-4 mr-1 text-green-500" /> Verified References Found: {verifiedReferences.length}
                                      </h4>
                                      <div className="flex items-center gap-2">
                                        <select value={citationFormat} onChange={(e) => setCitationFormat(e.target.value)} className="text-xs border-gray-300 rounded px-2 py-1 outline-none">
                                          {["IEEE", "APA", "MLA", "Chicago", "ACM", "Springer"].map(f => <option key={f} value={f}>{f}</option>)}
                                        </select>
                                        <button onClick={insertReferences} className="px-3 py-1 bg-blue-600 text-white rounded text-xs font-medium hover:bg-blue-700">
                                          Insert
                                        </button>
                                      </div>
                                    </div>
                                    <div className="space-y-3 max-h-60 overflow-y-auto pr-2 text-xs text-blue-800 font-medium">
                                      {verifiedReferences.map((r, i) => (
                                        <div key={i} className="p-3 bg-white rounded border border-blue-50 shadow-sm relative">
                                          <div className="font-bold pr-16">{r.title}</div>
                                          {r.source && (
                                              <span className="absolute top-2 right-2 bg-blue-100 text-blue-800 text-[9px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wide">
                                                  {r.source}
                                              </span>
                                          )}
                                          <div className="text-gray-600 font-normal mt-1">{r.authors} • {r.year}</div>
                                          <div className="text-gray-500 font-normal mt-0.5 truncate text-[10px]">DOI: <a href={r.url} target="_blank" rel="noreferrer" className="text-blue-500 hover:underline">{r.doi}</a> • {r.container || r.publisher}</div>
                                          {r.verified && (
                                              <div className="flex gap-2 mt-2 border-t border-gray-100 pt-1.5">
                                                  <span className={`flex items-center text-[9px] font-bold uppercase tracking-wide ${r.verified.doi ? 'text-green-600' : 'text-gray-400'}`}>
                                                      {r.verified.doi && <CheckCircle className="w-2.5 h-2.5 mr-0.5" />} DOI
                                                  </span>
                                                  <span className={`flex items-center text-[9px] font-bold uppercase tracking-wide ${r.verified.authors ? 'text-green-600' : 'text-gray-400'}`}>
                                                      {r.verified.authors && <CheckCircle className="w-2.5 h-2.5 mr-0.5" />} Authors
                                                  </span>
                                                  <span className={`flex items-center text-[9px] font-bold uppercase tracking-wide ${r.verified.source ? 'text-green-600' : 'text-gray-400'}`}>
                                                      {r.verified.source && <CheckCircle className="w-2.5 h-2.5 mr-0.5" />} Source
                                                  </span>
                                              </div>
                                          )}
                                        </div>
                                      ))}
                                    </div>
                                  </motion.div>
                                )}

                                <Markdown>{generatedPaper.references}</Markdown>
                            </div>

                            {/* Academic Review Section */}
                            <div className="mt-12 pt-6 border-t border-gray-300">
                                <div className="flex flex-wrap gap-4 items-center justify-between mb-4">
                                  <h2 className="text-xl font-bold">Academic Review & Improvement</h2>
                                  <button onClick={handleReviewPaper} disabled={loading} className="px-4 py-2 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 rounded-lg text-sm font-medium flex items-center transition-colors disabled:opacity-50">
                                    {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
                                    Run Automated Peer Review
                                  </button>
                                </div>
                                
                                {generatedPaper.review && (
                                    <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="mb-6 bg-white border border-indigo-200 rounded-xl overflow-hidden shadow-sm">
                                        <div className="p-4 bg-indigo-50 border-b border-indigo-200 flex justify-between items-center">
                                            <h4 className="font-bold text-indigo-900">Faculty-Style Evaluation</h4>
                                            <div className="text-lg font-black text-indigo-700">{generatedPaper.review.overallScore}/100</div>
                                        </div>
                                        <div className="p-4 space-y-4">
                                            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                                                <div className="p-3 bg-white border rounded">
                                                    <div className="text-xs text-gray-500 mb-1">Novelty</div>
                                                    <div className="font-bold">{generatedPaper.review.categoryScores.novelty} / 100</div>
                                                </div>
                                                <div className="p-3 bg-white border rounded">
                                                    <div className="text-xs text-gray-500 mb-1">Technical Depth</div>
                                                    <div className="font-bold">{generatedPaper.review.categoryScores.technicalDepth} / 100</div>
                                                </div>
                                                <div className="p-3 bg-white border rounded">
                                                    <div className="text-xs text-gray-500 mb-1">Methodology</div>
                                                    <div className="font-bold">{generatedPaper.review.categoryScores.methodology} / 100</div>
                                                </div>
                                                <div className="p-3 bg-white border rounded">
                                                    <div className="text-xs text-gray-500 mb-1">Writing</div>
                                                    <div className="font-bold">{generatedPaper.review.categoryScores.academicWriting} / 100</div>
                                                </div>
                                            </div>

                                            {generatedPaper.review.strengths && generatedPaper.review.strengths.length > 0 && (
                                                <div className="mt-4">
                                                    <h5 className="font-semibold text-green-700 mb-2 text-sm">Strengths</h5>
                                                    <ul className="list-disc pl-5 text-sm text-gray-600 space-y-1">
                                                        {generatedPaper.review.strengths.map((s, i) => <li key={i}>{s}</li>)}
                                                    </ul>
                                                </div>
                                            )}

                                            {generatedPaper.review.weaknesses && generatedPaper.review.weaknesses.length > 0 && (
                                                <div className="mt-4">
                                                    <h5 className="font-semibold text-red-700 mb-2 text-sm">Weaknesses</h5>
                                                    <ul className="list-disc pl-5 text-sm text-gray-600 space-y-1">
                                                        {generatedPaper.review.weaknesses.map((s, i) => <li key={i}>{s}</li>)}
                                                    </ul>
                                                </div>
                                            )}
                                            
                                            {generatedPaper.review.actionableImprovements && generatedPaper.review.actionableImprovements.length > 0 && (
                                                <div className="mt-4 pt-4 border-t border-gray-100">
                                                    <h5 className="font-semibold text-indigo-900 mb-2 text-sm">Actionable Improvements</h5>
                                                    <ul className="list-disc pl-5 text-sm text-gray-600 space-y-1">
                                                        {generatedPaper.review.actionableImprovements.map((s, i) => <li key={i}>{s}</li>)}
                                                    </ul>
                                                    <div className="mt-4 flex justify-end">
                                                      <button onClick={handleImprovePaper} disabled={loading} className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm font-medium flex items-center transition-colors shadow-sm disabled:opacity-50">
                                                          {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <PenTool className="w-4 h-4 mr-2" />}
                                                          Improve Paper based on Review
                                                      </button>
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    </motion.div>
                                )}
                                
                                {generatedPaper.previousVersion && (
                                   <div className="mt-4 p-4 bg-gray-50 border border-gray-200 rounded-lg flex items-center justify-between">
                                      <div>
                                        <h4 className="font-semibold text-sm text-gray-800">Viewing Version {generatedPaper.version}</h4>
                                        <p className="text-xs text-gray-500">Previous version exists.</p>
                                      </div>
                                      <button onClick={switchVersion} className="px-3 py-1.5 bg-white border border-gray-300 rounded text-xs font-medium text-gray-700 hover:bg-gray-50 transition-colors">
                                        Compare / Revert to V{generatedPaper.previousVersion.version || 1}
                                      </button>
                                   </div>
                                )}
                            </div>

                            {/* Compliance Section */}
                            {generatedPaper.mode !== "draft" && (
                              <div className="mt-12 pt-6 border-t border-gray-300">
                                  <div className="flex flex-wrap gap-4 items-center justify-between mb-4">
                                    <h2 className="text-xl font-bold">Format Compliance</h2>
                                    <button onClick={handleRunCompliance} disabled={complianceLoading} className="px-4 py-2 bg-purple-50 text-purple-700 hover:bg-purple-100 rounded-lg text-sm font-medium flex items-center transition-colors disabled:opacity-50">
                                      {complianceLoading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
                                      Run Compliance Check
                                    </button>
                                  </div>
                                  
                                  {complianceReport && (
                                      <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="mb-6 bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm">
                                          <div className="p-4 bg-gray-50 border-b border-gray-200 flex justify-between items-center">
                                              <h4 className="font-bold text-gray-800">{formData.publicationFormat} Document Quality</h4>
                                              <div className="text-lg font-black text-purple-700">{complianceReport.scores?.overall !== undefined ? complianceReport.scores.overall + '%' : 'N/A'}</div>
                                          </div>
                                          <div className="p-4 space-y-4">
                                              
                                              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                                                  <div className="p-3 bg-white border rounded">
                                                      <div className="text-xs text-gray-500 mb-1">Citation Quality</div>
                                                      <div className="font-bold">{complianceReport.scores?.citationAccuracy !== undefined ? complianceReport.scores.citationAccuracy + '%' : 'N/A'}</div>
                                                  </div>
                                                  <div className="p-3 bg-white border rounded">
                                                      <div className="text-xs text-gray-500 mb-1">Literature Quality</div>
                                                      <div className="font-bold">{complianceReport.scores?.literatureQuality !== undefined ? complianceReport.scores.literatureQuality + '%' : 'N/A'}</div>
                                                  </div>
                                                  <div className="p-3 bg-white border rounded">
                                                      <div className="text-xs text-gray-500 mb-1">Methodology</div>
                                                      <div className="font-bold">{complianceReport.scores?.methodologyConsistency !== undefined ? complianceReport.scores.methodologyConsistency + '%' : 'N/A'}</div>
                                                  </div>
                                                  <div className="p-3 bg-white border rounded">
                                                      <div className="text-xs text-gray-500 mb-1">Writing Quality</div>
                                                      <div className="font-bold">{complianceReport.scores?.academicWriting !== undefined ? complianceReport.scores.academicWriting + '%' : 'N/A'}</div>
                                                  </div>
                                              </div>

                                              {complianceReport.criticalIssues && complianceReport.criticalIssues.length > 0 && (
                                                  <div className="p-4 bg-orange-50 rounded-lg border border-orange-100">
                                                      <h5 className="text-sm font-bold text-orange-800 mb-2 flex items-center">
                                                          <span className="flex items-center justify-center w-4 h-4 mr-2 font-black text-orange-600">!</span>
                                                          Notice: Validation Status
                                                      </h5>
                                                      <ul className="list-disc pl-4 text-sm text-orange-700 space-y-1">
                                                          {complianceReport.criticalIssues?.map((r: string, i: number) => <li key={i}>{r}</li>)}
                                                      </ul>
                                                  </div>
                                              )}

                                              {complianceReport.recommendations && complianceReport.recommendations.length > 0 && (
                                                  <div className="mt-4 pt-4 border-t border-gray-100">
                                                      <h5 className="font-semibold text-gray-700 mb-2 text-sm text-purple-900">Recommendations</h5>
                                                      <ul className="list-disc pl-5 text-sm text-gray-600 space-y-1">
                                                          {complianceReport.recommendations.map((r: string, i: number) => <li key={i}>{r}</li>)}
                                                      </ul>
                                                  </div>
                                              )}
                                          </div>
                                      </motion.div>
                                  )}
                              </div>
                            )}

                            {/* Final Compilation Section */}
                            <div className="mt-12 pt-6 border-t border-gray-300">
                                <h2 className="text-xl font-bold mb-4">Compile Final Paper</h2>
                                <p className="text-sm text-gray-600 mb-4">Merge paper, references, and format into the final output.</p>
                                <div className="flex flex-wrap gap-2">
                                    <button onClick={() => {
                                        const fullText = generatedPaper.title + "\n\nAbstract\n" + generatedPaper.abstract + "\n\n" + generatedPaper.sections.map(s => s.title + "\n" + s.content).join("\n\n") + "\n\nReferences\n" + generatedPaper.references;
                                        copyToClipboard(fullText);
                                    }} className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg text-sm font-medium flex items-center">
                                        <Copy className="w-4 h-4 mr-2" /> Copy Markdown
                                    </button>
                                    <button onClick={downloadDocx} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium flex items-center transition-colors cursor-pointer">
                                        <Download className="w-4 h-4 mr-2" /> Download DOCX
                                    </button>
                                    <button onClick={downloadPDF} className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-medium flex items-center transition-colors cursor-pointer">
                                        <Download className="w-4 h-4 mr-2" /> Download PDF
                                    </button>
                                    <button onClick={downloadBibtex} className="px-4 py-2 bg-gray-800 hover:bg-gray-900 text-white rounded-lg text-sm font-medium flex items-center cursor-pointer">
                                        <Download className="w-4 h-4 mr-2" /> Download BibTeX
                                    </button>
                                    <button onClick={downloadLatex} className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-800 rounded-lg text-sm font-medium flex items-center transition-colors cursor-pointer">
                                        <Download className="w-4 h-4 mr-2" /> LaTeX
                                    </button>
                                </div>
                            </div>

                        </div>
                    </div>
                </motion.div>
            )}
        </div>

      </div>
      <AnimatePresence>
        {showToast && <Toast message={toastMessage} onClose={() => setShowToast(false)} />}
      </AnimatePresence>
    </div>
  );
}
