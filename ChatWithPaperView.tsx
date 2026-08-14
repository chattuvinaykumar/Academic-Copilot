import React, { useState, useRef, useEffect } from "react";
import { ChatMessage } from "./types";
import { motion, AnimatePresence } from "motion/react";
import { Send, Loader2, Bot, User, AlertCircle } from "lucide-react";
import Markdown from "react-markdown";
import { getAuthHeaders } from "./supabase";

function ChatLoadingMessages() {
  const [index, setIndex] = useState(0);
  const messages = ["Searching document...", "Analyzing context...", "Generating answer..."];
  useEffect(() => {
    const interval = setInterval(() => {
      setIndex((idx) => Math.min(idx + 1, messages.length - 1));
    }, 2500); 
    return () => clearInterval(interval);
  }, []);
  return (
    <span className="text-sm text-gray-500 relative flex items-center h-5 w-32 overflow-hidden">
      <AnimatePresence mode="wait">
        <motion.span 
          key={index} 
          initial={{ opacity: 0, y: 5 }} 
          animate={{ opacity: 1, y: 0 }} 
          exit={{ opacity: 0, y: -5 }}
          className="absolute whitespace-nowrap"
        >
          {messages[index]}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

interface ChatWithPaperViewProps {
  documentId: string;
}

export function ChatWithPaperView({ documentId }: ChatWithPaperViewProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([{
      role: "model",
      text: "Hello! I've read the document. What would you like to know?"
  }]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || !documentId) return;

    const userMessage: ChatMessage = { role: "user", text: input };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput("");
    setLoading(true);

    try {
      // Exclude the very first greeting message from history to save tokens unless necessary
      const history = newMessages.slice(1, -1);

      const authHeaders = await getAuthHeaders();
      const response = await fetch("/api/chat-document", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({
          documentId,
          history,
          message: userMessage.text
        })
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Failed to get response");
      }

      const data = await response.json();
      setMessages([...newMessages, { role: "model", text: data.result }]);
    } catch (err: any) {
       setMessages([...newMessages, { role: "model", text: `**Error:** ${err.message}` }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-16rem)] bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden relative max-w-4xl mx-auto">
      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {messages.map((msg, idx) => (
           <motion.div 
             key={idx} 
             initial={{ opacity: 0, y: 10 }}
             animate={{ opacity: 1, y: 0 }}
             className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
           >
             <div className={`flex max-w-[85%] ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'} items-start gap-3`}>
               <div className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center mt-1 ${msg.role === 'user' ? 'bg-blue-600 text-white' : 'bg-gray-800 text-white'}`}>
                 {msg.role === 'user' ? <User className="w-5 h-5" /> : <Bot className="w-5 h-5" />}
               </div>
               <div className={`px-4 py-3 rounded-2xl ${msg.role === 'user' ? 'bg-blue-600 text-white rounded-tr-sm' : 'bg-gray-100 text-gray-800 rounded-tl-sm'}`}>
                 <div className={`prose prose-sm font-sans ${msg.role === 'user' ? 'prose-invert text-white' : 'text-gray-800'}`}>
                    <Markdown>{msg.text}</Markdown>
                 </div>
               </div>
             </div>
           </motion.div>
        ))}
        {loading && (
             <motion.div 
             initial={{ opacity: 0 }}
             animate={{ opacity: 1 }}
             className="flex justify-start"
           >
             <div className="flex max-w-[85%] flex-row items-start gap-3">
               <div className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center mt-1 bg-gray-800 text-white">
                 <Bot className="w-5 h-5" />
               </div>
               <div className="px-4 py-3 rounded-2xl bg-gray-100 text-gray-800 rounded-tl-sm flex items-center gap-2">
                 <Loader2 className="w-4 h-4 animate-spin text-gray-500" />
                 <ChatLoadingMessages />
               </div>
             </div>
           </motion.div>
        )}
        <div ref={messagesEndRef} />
      </div>
      <div className="p-4 bg-white border-t border-gray-100">
         <form 
           onSubmit={(e) => { e.preventDefault(); handleSend(); }}
           className="relative flex items-center"
         >
           <input
             type="text"
             value={input}
             onChange={(e) => setInput(e.target.value)}
             placeholder="Ask a question about the paper..."
             className="w-full pl-4 pr-12 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white transition-colors"
             disabled={loading}
           />
           <button
             type="submit"
             disabled={!input.trim() || loading}
             className="absolute right-2 p-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
           >
             <Send className="w-4 h-4" />
           </button>
         </form>
         <div className="text-center mt-2">
            <span className="text-xs text-gray-400 flex items-center justify-center">
              <AlertCircle className="w-3 h-3 mr-1" />
              AI answers are based strictly on the uploaded document context.
            </span>
         </div>
      </div>
    </div>
  );
}
