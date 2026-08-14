import React, { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Search, Loader2, Target, Lightbulb, FileSearch, ArrowRight, Activity, Zap } from "lucide-react";
import Markdown from "react-markdown";
import { getAuthHeaders } from "./supabase";

interface GapReport {
  query: string;
  noveltyStatement: string;
  gaps: {
    title: string;
    description: string;
    foundIn: string;
  }[];
  projectMapping: string;
  futureDirections: string[];
  confidenceScore: number;
}

export function ResearchGapView() {
  const [formData, setFormData] = useState({
    title: "",
    domain: "",
    description: ""
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<GapReport | null>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleAnalyze = async () => {
    if (!formData.title || !formData.domain) {
      setError("Project Title and Domain are required.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const authHeaders = await getAuthHeaders();
      const response = await fetch("/api/analyze-gaps", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify(formData)
      });
      if (!response.ok) {
        throw new Error("Failed to perform gap analysis.");
      }
      const data = await response.json();
      setReport(data.result);
    } catch (err: any) {
      setError(err.message || "An unexpected error occurred.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col lg:flex-row gap-8">
      <div className="w-full lg:w-1/3 bg-white p-6 rounded-2xl shadow-sm border border-gray-100 flex flex-col h-[calc(100vh-10rem)] overflow-y-auto">
        <div className="mb-6">
            <h3 className="text-xl font-bold text-gray-900 flex items-center">
            <Target className="w-5 h-5 mr-2 text-indigo-600" />
            Gap Analysis Engine
            </h3>
            <p className="text-sm text-gray-500 mt-2">
            Map your proposed project against current literature to identify research gaps and novelty.
            </p>
        </div>
        
        <div className="space-y-4 flex-1">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Project Title *</label>
            <input type="text" name="title" value={formData.title} onChange={handleChange} className="w-full px-3 py-2 border border-gray-300 rounded-lg outline-none focus:ring-2 focus:ring-indigo-500" placeholder="e.g., Federated Learning for IoT" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Domain *</label>
            <input type="text" name="domain" value={formData.domain} onChange={handleChange} className="w-full px-3 py-2 border border-gray-300 rounded-lg outline-none focus:ring-2 focus:ring-indigo-500" placeholder="e.g., Cybersecurity, Machine Learning" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Description / Abstract</label>
            <textarea name="description" value={formData.description} onChange={handleChange} rows={5} className="w-full px-3 py-2 border border-gray-300 rounded-lg outline-none focus:ring-2 focus:ring-indigo-500" placeholder="Briefly describe what your project aims to do..." />
          </div>
        </div>

        {error && <div className="mt-4 p-3 bg-red-50 text-red-600 text-sm rounded-lg">{error}</div>}

        <div className="mt-6 flex flex-col gap-2">
            <button onClick={handleAnalyze} disabled={loading} className="w-full flex items-center justify-center space-x-2 bg-indigo-600 hover:bg-indigo-700 text-white py-3 rounded-lg font-medium transition-colors disabled:opacity-70">
                {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Search className="w-5 h-5" />}
                <span>{loading ? "Analyzing Literature..." : "Run Gap Analysis"}</span>
            </button>
        </div>
      </div>

      <div className="w-full lg:w-2/3 bg-white p-6 rounded-2xl shadow-sm border border-gray-100 overflow-y-auto h-[calc(100vh-10rem)] relative">
         {!report && !loading && (
             <div className="h-full flex flex-col items-center justify-center text-gray-400 text-center px-4">
                 <FileSearch className="w-16 h-16 mb-4 text-gray-200" />
                 <p className="max-w-md">Enter your project concept to automatically discover verified research gaps from Semantic Scholar and arXiv, and see how your project maps to real-world academic needs.</p>
             </div>
         )}
         
         {loading && (
             <div className="h-full flex flex-col items-center justify-center text-indigo-600">
                 <Loader2 className="w-10 h-10 animate-spin mb-4" />
                 <p className="font-medium animate-pulse">Running Research Gap Analysis...</p>
                 <p className="text-sm text-gray-500 mt-2">Retrieving and analyzing latest publications</p>
             </div>
         )}

         {report && !loading && (
             <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-8 pb-10">
                 
                 <div className="flex justify-between items-start border-b pb-6">
                    <div>
                        <h2 className="text-2xl font-bold text-gray-900 font-sans">Research Gap Report</h2>
                        <p className="text-sm text-gray-500 mt-1">Literature Query: <span className="font-medium">"{report.query}"</span></p>
                    </div>
                    <div className="flex flex-col items-end">
                        <div className="text-3xl font-black text-indigo-600">{report.confidenceScore}%</div>
                        <div className="text-[10px] text-gray-500 uppercase tracking-widest font-bold">Confidence Score</div>
                    </div>
                 </div>

                 <section>
                    <h3 className="text-lg font-bold flex items-center text-gray-800 mb-4">
                        <Activity className="w-5 h-5 mr-2 text-red-500" />
                        Identified Gaps in Literature
                    </h3>
                    <div className="space-y-4">
                        {report.gaps.map((gap, i) => (
                            <div key={i} className="p-4 rounded-xl border border-red-100 bg-red-50/30">
                                <h4 className="font-bold text-gray-900 text-sm mb-1">{gap.title}</h4>
                                <p className="text-sm text-gray-700 mb-3">{gap.description}</p>
                                <div className="text-xs text-gray-500 bg-white inline-block px-2 py-1 rounded border border-gray-200 font-medium">
                                    <span className="text-red-500 mr-1 font-bold">Found in:</span> {gap.foundIn}
                                </div>
                            </div>
                        ))}
                    </div>
                 </section>

                 <section>
                    <h3 className="text-lg font-bold flex items-center text-gray-800 mb-4">
                        <Zap className="w-5 h-5 mr-2 text-yellow-500" />
                        Project-to-Gap Mapping
                    </h3>
                    <div className="p-5 rounded-xl border border-indigo-100 bg-indigo-50/30">
                        <div className="prose prose-sm font-sans text-gray-800 max-w-none">
                            <Markdown>{report.projectMapping}</Markdown>
                        </div>
                    </div>
                 </section>

                 <section>
                    <h3 className="text-lg font-bold flex items-center text-gray-800 mb-4">
                        <Target className="w-5 h-5 mr-2 text-green-500" />
                        Novelty Statement
                    </h3>
                    <div className="p-5 border-l-4 border-green-500 bg-gray-50">
                        <div className="prose prose-sm font-sans text-gray-800 max-w-none italic">
                            <Markdown>{report.noveltyStatement}</Markdown>
                        </div>
                    </div>
                 </section>

                 <section>
                    <h3 className="text-lg font-bold flex items-center text-gray-800 mb-4">
                        <Lightbulb className="w-5 h-5 mr-2 text-blue-500" />
                        Future Research Directions
                    </h3>
                    <ul className="space-y-2">
                        {report.futureDirections.map((dir, i) => (
                            <li key={i} className="flex items-start bg-white p-3 border border-gray-100 rounded-lg shadow-sm">
                                <ArrowRight className="w-4 h-4 text-blue-400 mr-2 mt-0.5 shrink-0" />
                                <span className="text-sm text-gray-700">{dir}</span>
                            </li>
                        ))}
                    </ul>
                 </section>

             </motion.div>
         )}
      </div>
    </div>
  );
}
