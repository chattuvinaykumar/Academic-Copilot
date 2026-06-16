/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import React, { useState } from "react";
import { FileUpload } from "./components/FileUpload";
import { SummaryResultView } from "./components/SummaryResultView";
import { CreatePaperView } from "./components/CreatePaperView";
import { CreateProjectView } from "./components/CreateProjectView";
import { ResearchGapView } from "./components/ResearchGapView";
import { ChatWithPaperView } from "./components/ChatWithPaperView";
import { ProgressIndicator } from "./components/ProgressIndicator";
import { Toast } from "./components/Toast";
import { SummaryResult } from "./types";
import { BookOpen, FilePlus, MessageSquare, Briefcase } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

export default function App() {
  const [activeTab, setActiveTab] = useState<"summarize" | "chat" | "create_paper" | "create_project" | "gap_analysis">("summarize");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SummaryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [showToast, setShowToast] = useState(false);
  
  const handleUploadSuccess = async (docId: string, file: File) => {
    setDocumentId(docId);
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/summarize-document", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId: docId }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to summarize paper");
      }

      const data = await response.json();
      setResult(data.result);
      setShowToast(true);
    } catch (err: any) {
      console.error(err);
      setError(err.message || "An unexpected error occurred");
    } finally {
      setLoading(false);
    }
  };

  const resetState = () => {
    setResult(null);
    setError(null);
    setDocumentId(null);
  };

  return (
    <div className="min-h-screen bg-[#FDFDFD] px-4 py-8 font-sans selection:bg-blue-100 selection:text-blue-900">
      <main className="max-w-6xl mx-auto flex flex-col h-full">
        <header className="mb-8 text-center space-y-4">
          <motion.div 
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="inline-flex items-center justify-center p-3 bg-gray-900 text-white rounded-2xl shadow-sm mb-2"
          >
            <BookOpen className="w-8 h-8" />
          </motion.div>
          <motion.h1 
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-3xl md:text-4xl font-bold tracking-tight text-gray-900"
          >
            Academic Copilot
          </motion.h1>
          <motion.p 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.1 }}
            className="text-gray-500 text-sm max-w-lg mx-auto"
          >
            AI-Powered Research, Publication, and Project Assistant
          </motion.p>
        </header>

        <div className="flex justify-center mb-8">
            <div className="inline-flex flex-wrap justify-center gap-1 bg-gray-100 p-1 rounded-xl">
                <button
                    onClick={() => setActiveTab("summarize")}
                    className={`px-4 sm:px-6 py-2 rounded-lg text-sm font-medium transition-all ${activeTab === 'summarize' ? 'bg-white shadow relative text-gray-900' : 'text-gray-500 hover:text-gray-700'}`}
                >
                    <BookOpen className="w-4 h-4 inline-block mr-2 -mt-0.5" />
                    Summarize Paper
                </button>
                <button
                    onClick={() => setActiveTab("chat")}
                    className={`px-4 sm:px-6 py-2 rounded-lg text-sm font-medium transition-all ${activeTab === 'chat' ? 'bg-white shadow relative text-gray-900' : 'text-gray-500 hover:text-gray-700'}`}
                >
                    <MessageSquare className="w-4 h-4 inline-block mr-2 -mt-0.5" />
                    Chat With Paper
                </button>
                <button
                    onClick={() => setActiveTab("create_paper")}
                    className={`px-4 sm:px-6 py-2 rounded-lg text-sm font-medium transition-all ${activeTab === 'create_paper' ? 'bg-white shadow relative text-gray-900' : 'text-gray-500 hover:text-gray-700'}`}
                >
                    <FilePlus className="w-4 h-4 inline-block mr-2 -mt-0.5" />
                    Create Research Paper
                </button>
                <button
                    onClick={() => setActiveTab("create_project")}
                    className={`px-4 sm:px-6 py-2 rounded-lg text-sm font-medium transition-all ${activeTab === 'create_project' ? 'bg-white shadow relative text-gray-900' : 'text-gray-500 hover:text-gray-700'}`}
                >
                    <Briefcase className="w-4 h-4 inline-block mr-2 -mt-0.5" />
                    Create Project
                </button>
                <button
                    onClick={() => setActiveTab("gap_analysis")}
                    className={`px-4 sm:px-6 py-2 rounded-lg text-sm font-medium transition-all ${activeTab === 'gap_analysis' ? 'bg-white shadow relative text-gray-900' : 'text-gray-500 hover:text-gray-700'}`}
                >
                    <BookOpen className="w-4 h-4 inline-block mr-2 -mt-0.5" />
                    Gap Analysis
                </button>
            </div>
        </div>

        <AnimatePresence mode="wait">
            {activeTab === "summarize" && (
                <motion.div key="summarize" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} className="flex-1">
                    {error && (
                    <div className="max-w-2xl mx-auto mb-8 p-4 bg-red-50 border border-red-100 rounded-xl text-red-600 text-sm text-center">
                        {error}
                    </div>
                    )}
                    
                    {!result ? (
                      <>
                        {loading ? (
                          <ProgressIndicator messages={[
                            "Processing document...",
                            "Extracting key information...",
                            "Generating summary...",
                            "Finalizing results..."
                          ]} />
                        ) : (
                          <FileUpload onUploadSuccess={handleUploadSuccess} isLoading={loading} />
                        )}
                      </>
                    ) : (
                      <SummaryResultView result={result} onReset={resetState} />
                    )}
                </motion.div>
            )}
            
            {activeTab === "chat" && (
                 <motion.div key="chat" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} className="flex-1">
                     {!documentId ? (
                         <div className="text-center py-20 px-4">
                            <h3 className="text-xl font-medium text-gray-800 mb-2">Upload a Document First</h3>
                            <p className="text-gray-500 mb-6">Please upload a paper in the "Summarize Paper" tab before chatting.</p>
                            <button onClick={() => setActiveTab('summarize')} className="px-6 py-2 bg-blue-600 text-white rounded-xl hover:bg-blue-700">Go to Upload</button>
                         </div>
                     ) : (
                        <ChatWithPaperView documentId={documentId} />
                     )}
                 </motion.div>
            )}

            {activeTab === "create_paper" && (
                <motion.div key="create_paper" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} className="flex-1">
                    <CreatePaperView />
                </motion.div>
            )}

            {activeTab === "create_project" && (
                <motion.div key="create_project" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} className="flex-1">
                    <CreateProjectView />
                </motion.div>
            )}

            {activeTab === "gap_analysis" && (
                <motion.div key="gap_analysis" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} className="flex-1">
                    <ResearchGapView />
                </motion.div>
            )}
        </AnimatePresence>
        
        <AnimatePresence>
            {showToast && <Toast message="Summary generated successfully!" onClose={() => setShowToast(false)} />}
        </AnimatePresence>
      </main>
    </div>
  );
}
