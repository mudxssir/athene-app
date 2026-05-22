import React from 'react';
import ReactMarkdown from 'react-markdown';
import { Calendar, Mail, FileText, ChevronRight, Brain, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

type SectionType = 'calendar' | 'emails' | 'docs' | 'knowledge';

interface BriefingSectionProps {
  type: SectionType;
  title: string;
  content: string;
  className?: string;
  status?: 'ok' | 'failed' | 'no_data';
}

const icons = {
  calendar: <Calendar className="w-5 h-5 text-primary" />,
  emails: <Mail className="w-5 h-5 text-secondary" />,
  docs: <FileText className="w-5 h-5 text-accent" />,
  knowledge: <Brain className="w-5 h-5 text-primary" />,
};

const gradients = {
  calendar: 'bg-primary/20',
  emails: 'bg-secondary/20',
  docs: 'bg-accent/20',
  knowledge: 'bg-primary/20',
};

const borderColors = {
  calendar: 'border-primary/20',
  emails: 'border-secondary/20',
  docs: 'border-accent/20',
  knowledge: 'border-primary/20',
};

export function BriefingSection({ type, title, content, className, status }: BriefingSectionProps) {
  return (
    <div className={cn(
      "group relative overflow-hidden rounded-[3rem] border bg-card/40 p-10 transition-all duration-700 hover:shadow-2xl hover:shadow-primary/5 hover:-translate-y-2 backdrop-blur-2xl font-['Space_Grotesk']",
      borderColors[type],
      className
    )}>
      {/* Dynamic Background Glow */}
      <div className={cn(
        "absolute -right-20 -top-20 h-96 w-96 blur-[120px] transition-all duration-1000 opacity-20 group-hover:opacity-40 group-hover:scale-125",
        gradients[type]
      )} />

      <div className="relative flex flex-col md:flex-row items-start gap-10">
        <div className={cn(
          "flex h-16 w-16 shrink-0 items-center justify-center rounded-[1.5rem] border bg-muted/50 backdrop-blur-3xl shadow-2xl transition-all duration-700 group-hover:scale-110 group-hover:rotate-6",
          borderColors[type]
        )}>
          {React.cloneElement(icons[type] as React.ReactElement<any>, { className: "w-8 h-8" })}
        </div>

        <div className="flex-1 space-y-6">
          <div className="flex items-center justify-between">
            <div className="space-y-2">
              <p className="text-[10px] uppercase tracking-[0.4em] font-black text-muted-foreground/40">Intelligence Sector</p>
              <h3 className="text-3xl font-black tracking-tighter text-foreground uppercase">{title}</h3>
            </div>
            <div className={cn(
              "h-10 w-10 rounded-xl border flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all duration-700 translate-x-6 group-hover:translate-x-0 shadow-lg",
              borderColors[type]
            )}>
              <ChevronRight className="w-5 h-5 text-muted-foreground" />
            </div>
          </div>

          {status === 'failed' && (
            <div className="text-amber-500 text-xs flex items-center gap-1.5 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 font-bold">
              <AlertCircle className="w-3.5 h-3.5" />
              Synthesis failed for this segment. Displaying raw activity stream.
            </div>
          )}

          <div className="prose prose-invert prose-p:text-muted-foreground prose-p:leading-relaxed prose-p:font-bold prose-strong:text-foreground prose-strong:font-black prose-sm max-w-none prose-headings:text-foreground prose-headings:font-black prose-li:text-muted-foreground prose-li:font-bold">
            <ReactMarkdown>
              {content || "_System currently indexing updates for this sector..._"}
            </ReactMarkdown>
          </div>
        </div>
      </div>
    </div>
  );
}

