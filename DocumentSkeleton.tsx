export function DocumentSkeleton() {
  return (
    <div className="w-full max-w-3xl mx-auto space-y-8 animate-pulse p-6">
       <div className="space-y-4 pt-10 pb-8 border-b border-gray-200">
         <div className="h-4 bg-gray-200 rounded w-1/4 mx-auto"></div>
         <div className="h-8 bg-gray-200 rounded w-3/4 mx-auto"></div>
         <div className="h-4 bg-gray-200 rounded w-1/2 mx-auto"></div>
       </div>

       {[...Array(4)].map((_, i) => (
         <div key={i} className="space-y-4">
           <div className="h-6 bg-gray-200 rounded w-1/3"></div>
           <div className="space-y-2">
             <div className="h-4 bg-gray-200 rounded w-full"></div>
             <div className="h-4 bg-gray-200 rounded w-[95%]"></div>
             <div className="h-4 bg-gray-200 rounded w-[90%]"></div>
             <div className="h-4 bg-gray-200 rounded w-[85%]"></div>
             <div className="h-4 bg-gray-200 rounded w-full"></div>
             <div className="h-4 bg-gray-200 rounded w-[75%]"></div>
           </div>
         </div>
       ))}
    </div>
  );
}
