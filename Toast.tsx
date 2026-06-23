import React, { useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { CheckCircle } from "lucide-react";

interface ToastProps {
  message: string;
  onClose: () => void;
}

export function Toast({ message, onClose }: ToastProps) {
  useEffect(() => {
    const t = setTimeout(onClose, 3000);
    return () => clearTimeout(t);
  }, [onClose]);

  return (
    <div className="fixed bottom-6 right-6 z-50">
       <motion.div 
         initial={{ opacity: 0, y: 20 }} 
         animate={{ opacity: 1, y: 0 }} 
         exit={{ opacity: 0, y: 20 }} 
         className="bg-gray-900 text-white px-4 py-3 rounded-xl shadow-lg flex items-center gap-3 border border-gray-700"
       >
          <CheckCircle className="w-5 h-5 text-green-400" />
          <span className="text-sm font-medium">{message}</span>
       </motion.div>
    </div>
  );
}
