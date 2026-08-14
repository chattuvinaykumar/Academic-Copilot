import React from "react";
import { SummaryResult as SummaryResultType } from "./types";
import { motion } from "motion/react";
import { FileText, Key, Download, Copy, RefreshCw, Briefcase, Activity, CheckCircle } from "lucide-react";
import { saveAs } from "file-saver";

interface SummaryResultViewProps {
  result: SummaryResultType;
  onReset: () => void;
}

export function SummaryResultView({ result, onReset }: SummaryResultViewProps) {
  
  const copyToClipboard = () => {
    const text = `${result.title}\n\nAbstract:\n${result.summary}\n\nKey Takeaways:\n${result.keyPoints.join("\n")}\n\nMethodology:\n${result.methodologySummary || ""}\n\nResults:\n${result.resultsSummary || ""}\n\nFuture Work:\n${result.futureWorkSummary || ""}\n\nKeywords: ${result.keywords.join(", ")}`;
    navigator.clipboard.writeText(text);
    alert("Copied to clipboard!");
  };

  const downloadTxt = () => {
    const text = `${result.title}\n\nAbstract:\n${result.summary}\n\nKey Takeaways:\n${result.keyPoints.join("\n")}\n\nMethodology:\n${result.methodologySummary || ""}\n\nResults:\n${result.resultsSummary || ""}\n\nFuture Work:\n${result.futureWorkSummary || ""}\n\nKeywords: ${result.keywords.join(", ")}`;
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    saveAs(blob, "Paper_Summary.txt");
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="w-full max-w-5xl mx-auto space-y-6 pb-20"
    >
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
        <div className="flex-1">
          <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-gray-900 leading-tight">
            {result.title}
          </h2>
          <div className="flex flex-wrap gap-2 mt-4">
            {result.keywords.map((keyword, i) => (
              <span
                key={i}
                className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-100"
              >
                {keyword}
              </span>
            ))}
          </div>
        </div>
        <div className="flex flex-col sm:flex-row gap-2 shrink-0">
          <button onClick={copyToClipboard} className="inline-flex items-center space-x-2 text-sm font-medium text-gray-700 hover:text-gray-900 bg-gray-50 border border-gray-200 hover:bg-gray-100 px-3 py-2 rounded-xl transition-colors">
            <Copy className="w-4 h-4" />
            <span>Copy</span>
          </button>
          <button onClick={downloadTxt} className="inline-flex items-center space-x-2 text-sm font-medium text-gray-700 hover:text-gray-900 bg-gray-50 border border-gray-200 hover:bg-gray-100 px-3 py-2 rounded-xl transition-colors">
            <Download className="w-4 h-4" />
            <span>Download</span>
          </button>
          <button
            onClick={onReset}
            className="inline-flex items-center space-x-2 text-sm font-medium text-blue-600 hover:text-blue-700 bg-blue-50 border border-blue-100 hover:bg-blue-100 px-4 py-2 rounded-xl transition-colors shrink-0"
          >
            <RefreshCw className="w-4 h-4" />
            <span>Summarize Another</span>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 pt-2">
        <div className="md:col-span-2 space-y-6">
          <Section icon={<FileText className="w-5 h-5" />} title="Abstract Summary">
            <div className="prose prose-sm sm:prose-base text-gray-700 leading-relaxed font-serif">
              {result.summary}
            </div>
          </Section>

          {result.methodologySummary && (
            <Section icon={<Briefcase className="w-5 h-5" />} title="Methodology">
              <div className="prose prose-sm sm:prose-base text-gray-700 leading-relaxed font-serif">
                {result.methodologySummary}
              </div>
            </Section>
          )}

          {result.resultsSummary && (
             <Section icon={<Activity className="w-5 h-5" />} title="Results">
             <div className="prose prose-sm sm:prose-base text-gray-700 leading-relaxed font-serif">
               {result.resultsSummary}
             </div>
           </Section>
          )}
          
          {result.limitations && (
             <Section icon={<Activity className="w-5 h-5" />} title="Limitations">
             <div className="prose prose-sm sm:prose-base text-gray-700 leading-relaxed font-serif">
               {result.limitations}
             </div>
           </Section>
          )}

          {result.futureWorkSummary && (
             <Section icon={<CheckCircle className="w-5 h-5" />} title="Future Work">
             <div className="prose prose-sm sm:prose-base text-gray-700 leading-relaxed font-serif">
               {result.futureWorkSummary}
             </div>
           </Section>
          )}
          
          {result.references && result.references.length > 0 && (
             <Section icon={<FileText className="w-5 h-5" />} title="Extracted References">
               <ul className="list-disc pl-5 space-y-1 text-sm text-gray-600 font-serif">
                 {result.references.map((ref, idx) => (
                    <li key={idx}>{ref}</li>
                 ))}
               </ul>
           </Section>
          )}

        </div>

        <div className="space-y-6">
          <Section icon={<Key className="w-5 h-5" />} title="Key Takeaways">
            <ul className="space-y-3">
              {result.keyPoints.map((point, index) => (
                <li key={index} className="flex gap-3 text-sm text-gray-700 leading-relaxed">
                  <span className="shrink-0 flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 text-gray-600 font-medium text-xs mt-0.5">
                    {index + 1}
                  </span>
                  <span>{point}</span>
                </li>
              ))}
            </ul>
          </Section>
        </div>
      </div>
    </motion.div>
  );
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl p-6 border border-gray-100 shadow-sm">
      <div className="flex items-center space-x-3 mb-4 pb-4 border-b border-gray-50">
        <div className="text-blue-600">
          {icon}
        </div>
        <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
      </div>
      <div>{children}</div>
    </div>
  );
}
