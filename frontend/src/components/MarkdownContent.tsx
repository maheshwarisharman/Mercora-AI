import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownContentProps {
  content: string;
  isUser?: boolean;
  className?: string;
}

export const MarkdownContent: React.FC<MarkdownContentProps> = ({
  content,
  isUser = false,
  className = "",
}) => {
  if (!content) return null;

  if (isUser) {
    return <p className={`leading-relaxed whitespace-pre-wrap ${className}`}>{content}</p>;
  }

  return (
    <div className={`markdown-content text-sm leading-relaxed text-[#18324b] ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ ...props }) => (
            <h1 className="text-base font-bold text-[#18324b] mt-3 mb-2 first:mt-0 pb-1 border-b border-[#dfe7e3]" {...props} />
          ),
          h2: ({ ...props }) => (
            <h2 className="text-sm font-bold text-[#18324b] mt-3 mb-1.5 first:mt-0 pb-0.5 border-b border-[#dfe7e3]/60" {...props} />
          ),
          h3: ({ ...props }) => (
            <h3 className="text-xs font-bold uppercase tracking-wider text-[#18324b] mt-2.5 mb-1 first:mt-0" {...props} />
          ),
          h4: ({ ...props }) => (
            <h4 className="text-xs font-bold text-[#18324b] mt-2 mb-1 first:mt-0" {...props} />
          ),
          p: ({ ...props }) => (
            <p className="mb-2.5 last:mb-0 leading-relaxed text-[#18324b]" {...props} />
          ),
          strong: ({ ...props }) => (
            <strong className="font-semibold text-[#18324b]" {...props} />
          ),
          em: ({ ...props }) => (
            <em className="italic text-[#2e5962]" {...props} />
          ),
          ul: ({ ...props }) => (
            <ul className="list-disc pl-5 my-2 space-y-1 text-[#18324b]" {...props} />
          ),
          ol: ({ ...props }) => (
            <ol className="list-decimal pl-5 my-2 space-y-1 text-[#18324b]" {...props} />
          ),
          li: ({ ...props }) => (
            <li className="leading-relaxed pl-0.5 marker:text-[#567079]" {...props} />
          ),
          blockquote: ({ ...props }) => (
            <blockquote className="border-l-2 border-[#c99548] bg-[#fbf7ee] text-[#567079] pl-3 pr-2 py-1.5 my-2.5 text-xs italic" {...props} />
          ),
          code: ({ inline, className: _codeClassName, children, ...props }: any) => {
            if (inline) {
              return (
                <code
                  className="font-mono text-[11px] font-semibold bg-[#eef3ef] text-[#18324b] px-1.5 py-0.5 border border-[#dfe7e3] rounded-none inline-block align-baseline"
                  {...props}
                >
                  {children}
                </code>
              );
            }
            return (
              <pre className="bg-[#18324b] text-[#fbfcfa] p-3 rounded-none overflow-x-auto my-2.5 border border-[#18324b] font-mono text-[11px] leading-relaxed">
                <code {...props}>{children}</code>
              </pre>
            );
          },
          table: ({ ...props }) => (
            <div className="w-full overflow-x-auto my-3 border border-[#dfe7e3] rounded-none">
              <table className="w-full text-xs text-left border-collapse" {...props} />
            </div>
          ),
          thead: ({ ...props }) => (
            <thead className="bg-[#f1f4f0] border-b border-[#dfe7e3] text-[#18324b] uppercase text-[10px] font-bold tracking-wider" {...props} />
          ),
          tbody: ({ ...props }) => (
            <tbody className="divide-y divide-[#dfe7e3] bg-[#fbfcfa]" {...props} />
          ),
          tr: ({ ...props }) => (
            <tr className="hover:bg-[#f1f4f0]/50 transition-colors" {...props} />
          ),
          th: ({ ...props }) => (
            <th className="px-3 py-2 border-r border-[#dfe7e3] last:border-r-0 font-bold" {...props} />
          ),
          td: ({ ...props }) => (
            <td className="px-3 py-2 border-r border-[#dfe7e3] last:border-r-0 text-[#18324b]" {...props} />
          ),
          hr: ({ ...props }) => (
            <hr className="border-[#dfe7e3] my-3" {...props} />
          ),
          a: ({ ...props }) => (
            <a className="text-[#29745d] underline font-medium hover:text-[#18324b] transition-colors" target="_blank" rel="noopener noreferrer" {...props} />
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
};

export default MarkdownContent;
