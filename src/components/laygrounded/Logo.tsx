import Image from "next/image";

export function Logo({ className = "" }: { className?: string }) {
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <Image 
        src="/images/logo.png" 
        alt="LayGrounded Logo" 
        width={32} 
        height={32} 
        className="object-contain"
      />
      <span className="text-xl tracking-tight">
        <span className="font-bold text-slate-900">Lay</span>
        <span className="font-medium text-slate-500">Grounded</span>
      </span>
    </div>
  );
}
