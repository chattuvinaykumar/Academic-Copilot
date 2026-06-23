import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";

interface ProgressIndicatorProps {
  messages: string[];
}

export function ProgressIndicator({ messages }: ProgressIndicatorProps) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setIndex((idx) => Math.min(idx + 1, messages.length - 1));
    }, 4000); 

    return () => clearInterval(interval);
  }, [messages]);

  return (
    <div className="flex flex-col items-center justify-center p-8 w-full h-full min-h-[300px]">
      <div className="w-12 h-12 border-4 border-gray-100 border-t-blue-600 rounded-full animate-spin mb-6"></div>
      
      <div className="h-8 relative w-full max-w-xs flex items-center justify-center overflow-hidden">
        <AnimatePresence mode="wait">
            <motion.p
              key={index}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="text-gray-700 font-medium text-center absolute"
            >
              {messages[index]}
            </motion.p>
        </AnimatePresence>
      </div>
      
      <p className="text-gray-400 text-sm mt-4 text-center">Usually takes 10–30 seconds depending on document size.</p>
    </div>
  );
}
