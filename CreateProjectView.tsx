import React, { useState, useRef, useEffect } from "react";
import { ProjectFormData, GeneratedProject } from "../types";
import { motion, AnimatePresence } from "motion/react";
import { Save, FileText, Loader2, Download, Copy, Briefcase, CheckCircle, XCircle } from "lucide-react";
import Markdown from "react-markdown";
import { saveAs } from "file-saver";
import { Document, Paragraph, HeadingLevel, Packer } from "docx";
import { jsPDF } from "jspdf";
import { ProgressIndicator } from "./ProgressIndicator";
import { DocumentSkeleton } from "./DocumentSkeleton";
import { Toast } from "./Toast";

const DEFAULT_FORM: ProjectFormData = {
  title: "",
  domain: "",
  objectives: "",
  technologies: "",
  description: "",
  expectedOutcomes: "",
  projectType: "Personal Project"
};

const PROJECT_TYPES = [
  "BTech Project", "MTech Project", "Personal Project", 
  "Office Project", "Startup Project", "Research Project"
];

export function CreateProjectView() {
  const [formData, setFormData] = useState<ProjectFormData>(DEFAULT_FORM);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generatedProject, setGeneratedProject] = useState<GeneratedProject | null>(null);
  const [showToast, setShowToast] = useState(false);
  const [toastMessage, setToastMessage] = useState("Project generated successfully!");
  const [complianceReport, setComplianceReport] = useState<any>(null);
  const [runningCompliance, setRunningCompliance] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (generatedProject && contentRef.current) {
        contentRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [generatedProject]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleGenerate = async () => {
    if (!formData.title || !formData.domain) {
      setError("Title and Domain are required.");
      return;
    }
    setLoading(true);
    setError(null);
    setComplianceReport(null);
    try {
      const response = await fetch("/api/generate-project", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData)
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Generation failed.");
      }
      const data = await response.json();
      setGeneratedProject(data.result);
      
      if (data.result.partial) {
          setToastMessage("Project generated partially. You may regenerate or continue.");
      } else {
          setToastMessage("Project generated. Running compliance checks...");
      }
      
      setShowToast(true);
      
      // Run asynchronously after generation without blocking UI
      runComplianceAudit(data.result);
      
    } catch (err: any) {
      setError(err.message || "An unexpected error occurred.");
    } finally {
      setLoading(false);
    }
  };

  const runComplianceAudit = async (projectOutput: any) => {
      setRunningCompliance(true);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

      try {
          const fullText = projectOutput.sections.map((s: any) => s.content).join("\n");
          const compResponse = await fetch("/api/check-compliance", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                  publicationFormat: projectOutput.projectType,
                  paperContent: fullText
              }),
              signal: controller.signal
          });
          
          clearTimeout(timeoutId);
          
          const compData = await compResponse.json();
          if (!compResponse.ok) {
             throw new Error(compData.details || compData.error || "Compliance API error");
          }
          setComplianceReport(compData.result);
      } catch(err: any) {
          clearTimeout(timeoutId);
          console.error("Compliance check failed", err);
          
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
            recommendations: ["Compliance check couldn't be completed. You can export the document, but please review it manually. Click 'Run Compliance Check' to retry."]
          });
      } finally {
          setRunningCompliance(false);
      }
  };

  const handleResumeGeneration = async () => {
    if (!generatedProject) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/resume-generation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "project report",
          existingContent: generatedProject,
          promptData: formData
        })
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Failed to resume generation.");
      }
      const data = await response.json();
      
      setGeneratedProject(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          sections: [...prev.sections, ...(data.result.sections || [])],
          partial: data.result.partial || false
        };
      });

      if (!data.result.partial) {
         setToastMessage("Generation successfully completed!");
         setShowToast(true);
      }
    } catch (err: any) {
      setError(err.message || "An unexpected error occurred.");
    } finally {
      setLoading(false);
    }
  };

  const clearForm = () => {
    setFormData(DEFAULT_FORM);
    setGeneratedProject(null);
  };

  const getWordCount = (text: string) => {
    return text.trim().split(/\s+/).filter(w => w.length > 0).length;
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    alert("Copied to clipboard!");
  };

  const downloadDocx = async () => {
    if (!generatedProject) return;
    setToastMessage("Generating DOCX...");
    setShowToast(true);
    
    try {
      const children: any[] = [];
      
      children.push(new Paragraph({
          text: generatedProject.title || "Untitled Project",
          heading: HeadingLevel.TITLE,
          spacing: { after: 400 }
      }));
      
      if (generatedProject.sections) {
          generatedProject.sections.forEach(sec => {
              if (!sec) return;
              children.push(new Paragraph({ text: sec.title || "Untitled Section", heading: HeadingLevel.HEADING_1 }));
              children.push(new Paragraph({ text: (sec.content || "").replace(/[*#`]/g, ""), spacing: { after: 200 } }));
          });
      }

      const doc = new Document({
          creator: "Academic Copilot",
          title: generatedProject.title || "Project Document",
          description: "Generated Project Document",
          sections: [{ children }]
      });

      const blob = await Packer.toBlob(doc);
      saveAs(blob, "Project_Document.docx");
      
      setToastMessage("Export Successful: DOCX downloaded.");
      setShowToast(true);
      console.log("Export started and completed: DOCX");
    } catch(err: any) {
      console.error("Docx generation error", err);
      setToastMessage(`Export Failed: ${err.message || 'Unknown error during DOCX generation'}`);
      setShowToast(true);
    }
  };

  const downloadPDF = () => {
    if (!generatedProject) return;
    setToastMessage("Generating PDF...");
    setShowToast(true);
    
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
      
      addText(generatedProject.title, 16, true);
      
      if (generatedProject.sections) {
          generatedProject.sections.forEach(sec => {
              if (!sec) return;
              addText(sec.title, 14, true);
              addText((sec.content || "").replace(/[*#`]/g, ""), 12);
          });
      }
      
      doc.save("Project_Document.pdf");
      
      setToastMessage("Export Successful: PDF downloaded.");
      setShowToast(true);
      console.log("Export started and completed: PDF");
    } catch (err: any) {
      console.error("PDF generation error", err);
      setToastMessage(`Export Failed: ${err.message || 'Unknown error during PDF generation'}`);
      setShowToast(true);
    }
  };

  return (
    <div className="flex flex-col lg:flex-row gap-8">
      <div className="w-full lg:w-1/3 bg-white p-6 rounded-2xl shadow-sm border border-gray-100 flex flex-col h-[calc(100vh-10rem)] overflow-y-auto">
        <h3 className="text-xl font-bold text-gray-900 mb-6 flex items-center">
          <Briefcase className="w-5 h-5 mr-2 text-blue-600" />
          Project Configuration
        </h3>
        
        <div className="space-y-4 flex-1">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Project Title *</label>
            <input type="text" name="title" value={formData.title} onChange={handleChange} className="w-full px-3 py-2 border border-gray-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500" placeholder="e.g., Hospital Management System" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Domain *</label>
            <input type="text" name="domain" value={formData.domain} onChange={handleChange} className="w-full px-3 py-2 border border-gray-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500" placeholder="e.g., Healthcare, AI" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Project Type</label>
            <select name="projectType" value={formData.projectType} onChange={handleChange} className="w-full px-3 py-2 border border-gray-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500">
                {PROJECT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Technologies</label>
            <textarea name="technologies" value={formData.technologies} onChange={handleChange} rows={2} className="w-full px-3 py-2 border border-gray-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500" placeholder="React, Node.js, MongoDB..." />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
            <textarea name="description" value={formData.description} onChange={handleChange} rows={3} className="w-full px-3 py-2 border border-gray-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Objectives</label>
            <textarea name="objectives" value={formData.objectives} onChange={handleChange} rows={2} className="w-full px-3 py-2 border border-gray-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Expected Outcomes</label>
            <textarea name="expectedOutcomes" value={formData.expectedOutcomes} onChange={handleChange} rows={2} className="w-full px-3 py-2 border border-gray-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
        </div>

        {error && <div className="mt-4 p-3 bg-red-50 text-red-600 text-sm rounded-lg">{error}</div>}

        <div className="mt-6 flex flex-col gap-2">
            <button onClick={handleGenerate} disabled={loading} className="w-full flex items-center justify-center space-x-2 bg-gray-900 hover:bg-gray-800 text-white py-3 rounded-lg font-medium transition-colors disabled:opacity-70">
                {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <FileText className="w-5 h-5" />}
                <span>Generate Project Document</span>
            </button>
            <div className="flex gap-2">
                <button onClick={clearForm} className="flex-1 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50 flex items-center justify-center">
                    Clear form
                </button>
            </div>
        </div>
      </div>

      <div className="w-full lg:w-2/3 flex flex-col gap-6">
        <div className="flex-1 bg-white p-6 rounded-2xl shadow-sm border border-gray-100 overflow-y-auto h-[calc(100vh-10rem)] relative">
            {loading ? (
                <div className="relative w-full h-full">
                  <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-white/60 backdrop-blur-sm">
                    <ProgressIndicator messages={[
                        "Analyzing requirements...",
                        "Designing architecture...",
                        "Generating documentation...",
                        "Preparing final output..."
                    ]} />
                  </div>
                  <DocumentSkeleton />
                </div>
            ) : !generatedProject ? (
                <div className="flex items-center justify-center h-full text-gray-400">
                    <p>Fill out the configuration to generate a project document.</p>
                </div>
            ) : (
                <motion.div ref={contentRef} initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="pb-20">
                    <div className="sticky top-0 bg-white/90 backdrop-blur pb-4 border-b border-gray-100 mb-6 flex flex-wrap gap-2 justify-between z-10">
                        <div className="text-xs font-semibold text-gray-500 py-1.5 flex items-center">
                            Word Count: {getWordCount(generatedProject.title + " " + generatedProject.sections.map(s => s.content).join(" "))}
                        </div>
                    </div>

                    <div className="max-w-3xl mx-auto space-y-8">
                        <div className="text-center border-b border-gray-200 pb-8">
                            <span className="text-sm font-semibold text-blue-600 uppercase tracking-widest">{generatedProject.projectType}</span>
                            <h1 className="text-3xl font-bold font-sans mt-2 mb-2 text-gray-900">{generatedProject.title}</h1>
                            <p className="text-gray-500">{generatedProject.domain}</p>
                        </div>

                        <div className="prose prose-sm md:prose-base max-w-none font-sans text-gray-800 pb-12">
                            {generatedProject.sections.map(sec => (
                                <div key={sec.id} className="mt-8 relative group">
                                    <h2 className="text-xl font-bold border-b pb-2 mb-4 pr-16">{sec.title}</h2>
                                    <div className="absolute top-0 right-0 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1">
                                       <button onClick={() => copyToClipboard(sec.content)} className="p-1 text-gray-400 hover:text-gray-700 bg-gray-100 rounded" title="Copy section"><Copy className="w-4 h-4" /></button>
                                    </div>
                                    <Markdown>{sec.content}</Markdown>
                                </div>
                            ))}
                        </div>

                        {generatedProject.partial && (
                             <div className="mt-8 p-4 bg-orange-50 border border-orange-200 rounded-lg text-center">
                                 <h3 className="text-orange-800 font-bold mb-2">Generation Incomplete</h3>
                                 <p className="text-orange-700 text-sm mb-4">The AI model hit a token limit or timeout before finishing the document. You can resume generation to add missing sections.</p>
                                 <button onClick={handleResumeGeneration} className="px-4 py-2 bg-orange-600 hover:bg-orange-700 text-white font-medium rounded-lg shadow-sm transition-colors text-sm">
                                     Resume Missing Sections
                                 </button>
                             </div>
                        )}

                        <div className="mt-12 bg-gray-50 border border-gray-200 rounded-xl p-6 mb-8">
                            <h3 className="text-lg font-bold text-gray-900 mb-4">Final Document Compilation & Compliance</h3>
                            
                            {runningCompliance && !complianceReport && (
                                <div className="text-sm font-medium text-blue-600 flex items-center mb-4 bg-blue-50 p-3 rounded">
                                    <Loader2 className="w-4 h-4 animate-spin mr-2" /> Running automated structural compliance check...
                                </div>
                            )}

                            {complianceReport && (
                                <div className="space-y-6 mb-6">
                                    <div className="flex items-center justify-between">
                                        <div>
                                            <h4 className="font-bold text-gray-900">Document Quality Score</h4>
                                            <p className="text-sm text-gray-500">Academic rigor & technical validation.</p>
                                        </div>
                                        <div className={`text-3xl font-black ${complianceReport.scores?.overall >= 80 ? 'text-green-600' : 'text-orange-500'}`}>
                                            {complianceReport.scores?.overall !== undefined ? complianceReport.scores.overall + '%' : 'N/A'}
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                                        <div className="p-3 bg-white border rounded">
                                            <div className="text-xs text-gray-500 mb-1">Citation Quality</div>
                                            <div className="font-bold">{complianceReport.scores?.citationAccuracy !== undefined ? complianceReport.scores.citationAccuracy + '%' : 'N/A'}</div>
                                        </div>
                                        <div className="p-3 bg-white border rounded">
                                            <div className="text-xs text-gray-500 mb-1">Methodology</div>
                                            <div className="font-bold">{complianceReport.scores?.methodologyConsistency !== undefined ? complianceReport.scores.methodologyConsistency + '%' : 'N/A'}</div>
                                        </div>
                                        <div className="p-3 bg-white border rounded">
                                            <div className="text-xs text-gray-500 mb-1">Academic Writing</div>
                                            <div className="font-bold">{complianceReport.scores?.academicWriting !== undefined ? complianceReport.scores.academicWriting + '%' : 'N/A'}</div>
                                        </div>
                                    </div>

                                    {complianceReport.criticalIssues && complianceReport.criticalIssues.length > 0 && (
                                         <div className="p-4 bg-orange-50 rounded-lg border border-orange-100">
                                            <h5 className="text-sm font-bold text-orange-800 mb-2 flex items-center">
                                                <span className="w-4 h-4 mr-2 font-bold flex items-center justify-center text-orange-600">!</span>
                                                Notice: Validation Status
                                            </h5>
                                            <ul className="list-disc pl-4 text-sm text-orange-700 space-y-1">
                                                {complianceReport.criticalIssues.map((r: string, i: number) => <li key={i}>{r}</li>)}
                                            </ul>
                                         </div>
                                    )}

                                    {complianceReport.recommendations && complianceReport.recommendations.length > 0 && (
                                        <div className="p-4 bg-orange-50 rounded-lg border border-orange-100">
                                            <h5 className="text-sm font-bold text-orange-800 mb-2">Recommendations for improvement:</h5>
                                            <ul className="list-disc pl-4 text-sm text-orange-700 space-y-1">
                                                {complianceReport.recommendations.map((r: string, i: number) => <li key={i}>{r}</li>)}
                                            </ul>
                                        </div>
                                    )}
                                </div>
                            )}

                            <div className="pt-4 border-t border-gray-200 flex gap-3 flex-wrap">
                                <button onClick={downloadPDF} className="flex-1 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-medium flex items-center justify-center transition-colors cursor-pointer">
                                    <Download className="w-4 h-4 mr-2" /> PDF Report
                                </button>
                                <button onClick={downloadDocx} className="flex-1 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium flex items-center justify-center transition-colors cursor-pointer">
                                    <Download className="w-4 h-4 mr-2" /> DOCX Report
                                </button>
                                <button onClick={() => {
                                    const fullText = generatedProject.title + "\n\n" + generatedProject.sections.map(s => s.title + "\n" + s.content).join("\n\n");
                                    copyToClipboard(fullText);
                                }} className="flex-1 py-2 bg-gray-800 hover:bg-gray-900 text-white rounded-lg text-sm font-medium flex items-center justify-center">
                                    <Copy className="w-4 h-4 mr-2" /> Markdown
                                </button>
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
