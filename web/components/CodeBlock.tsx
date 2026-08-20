"use client";

import { useState } from "react";

export function CodeBlock({
  filename,
  code,
  maxHeight = 420,
}: {
  filename: string;
  code: string;
  maxHeight?: number;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-[#0a0e14]">
      <div className="flex items-center justify-between border-b border-line bg-panel2/70 px-3 py-1.5">
        <span className="num text-[11px] text-muted">{filename}</span>
        <button
          onClick={copy}
          className="text-[11px] font-medium text-muted transition-colors hover:text-acc"
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <pre
        className="overflow-auto p-3 text-[11.5px] leading-relaxed text-[#d4d8e2]"
        style={{ maxHeight }}
      >
        <code>{code}</code>
      </pre>
    </div>
  );
}