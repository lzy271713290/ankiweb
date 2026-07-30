'use client';

import { useState, useCallback } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Pencil, Trash2, Check, X, RotateCw } from 'lucide-react';
import { CARD_TYPE_META, type KnowledgeCard } from '@/lib/types';

interface AnkiCardItemProps {
  card: KnowledgeCard;
  index: number;
  onEdit: (id: string, updates: Partial<KnowledgeCard>) => void;
  onDelete: (id: string) => void;
}

function renderClozeText(text: string, reveal: boolean): string {
  return escapeHtml(text).replace(
    /\{\{c(\d+)::(.*?)(?:::(.*?))?}}/g,
    (_match, _cId, answer, hint) => {
      if (reveal) {
        return `<span class="cloze-highlight">${answer}</span>`;
      }
      return `<span class="cloze-blank">${hint ? `[${hint}]` : '...'}</span>`;
    },
  );
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;',
      })[character] || character,
  );
}

export function AnkiCardItem({ card, index, onEdit, onDelete }: AnkiCardItemProps) {
  const [flipped, setFlipped] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editQuestion, setEditQuestion] = useState(card.question);
  const [editAnswer, setEditAnswer] = useState(card.answer);
  const [editCategory, setEditCategory] = useState(card.category);

  const handleFlip = useCallback(() => {
    if (!editing) setFlipped((f) => !f);
  }, [editing]);

  const handleSave = () => {
    onEdit(card.id, {
      question: editQuestion,
      answer: editAnswer,
      category: editCategory,
      source_section: editCategory,
    });
    setEditing(false);
  };

  const handleCancel = () => {
    setEditQuestion(card.question);
    setEditAnswer(card.answer);
    setEditCategory(card.category);
    setEditing(false);
  };

  const isCloze = card.card_type === 'cloze';
  const tagColor =
    card.card_type === 'cloze'
      ? 'bg-amber-soft text-amber'
      : card.card_type === 'reverse'
        ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300'
        : card.card_type === 'compare'
          ? 'bg-rose-50 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300'
          : card.card_type === 'sequence'
            ? 'bg-sky-50 text-sky-700 dark:bg-sky-950/50 dark:text-sky-300'
            : 'bg-indigo-soft text-indigo';

  const tagLabel = CARD_TYPE_META[card.card_type].shortLabel;

  return (
    <div
      className="animate-card-enter hover-lift"
      style={{ animationDelay: `${Math.min(index * 90, 800)}ms` }}
    >
      <div
        className={`card-flip-container ${flipped && !editing ? 'flipped' : ''}`}
        onClick={handleFlip}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleFlip();
          }
        }}
      >
        <div className="card-flip-inner min-h-[160px] cursor-pointer">
          <div className="card-flip-front rounded-xl border border-border bg-card p-4 shadow-sm transition-shadow hover:shadow-md">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${tagColor}`}>
                  {tagLabel}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {card.category}
                </span>
              </div>
              <span className="text-[10px] tabular-nums text-muted-foreground/60 font-mono">
                #{String(index + 1).padStart(2, '0')}
              </span>
            </div>

            {!editing ? (
              <div
                className="text-[14.5px] leading-relaxed font-medium text-card-foreground"
                dangerouslySetInnerHTML={{
                  __html: isCloze
                    ? renderClozeText(card.question, false)
                    : escapeHtml(card.question).replace(/\n/g, '<br/>'),
                }}
              />
            ) : (
              <div className="space-y-2" onClick={(e) => e.stopPropagation()}>
                <Textarea
                  value={editQuestion}
                  onChange={(e) => setEditQuestion(e.target.value)}
                  className="min-h-[80px] text-sm"
                  placeholder="问题内容"
                />
                {!isCloze && (
                  <Textarea
                    value={editAnswer}
                    onChange={(e) => setEditAnswer(e.target.value)}
                    className="min-h-[60px] text-sm"
                    placeholder="答案"
                  />
                )}
                <input
                  type="text"
                  value={editCategory}
                  onChange={(e) => setEditCategory(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-xs"
                  placeholder="分类"
                />
              </div>
            )}

            {!editing && (
              <div className="mt-3 flex items-center justify-between">
                <span className="text-[11px] text-muted-foreground/50 flex items-center gap-1">
                  <RotateCw className="h-3 w-3" />
                  点击查看答案
                </span>
                <div
                  className="flex gap-1"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 w-7 p-0"
                    onClick={() => setEditing(true)}
                    aria-label={`编辑第 ${index + 1} 张卡片`}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                    onClick={() => onDelete(card.id)}
                    aria-label={`删除第 ${index + 1} 张卡片`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            )}

            {editing && (
              <div
                className="mt-3 flex gap-2"
                onClick={(e) => e.stopPropagation()}
              >
                <Button
                  size="sm"
                  className="h-7"
                  onClick={handleSave}
                >
                  <Check className="h-3.5 w-3.5 mr-1" />
                  保存
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7"
                  onClick={handleCancel}
                >
                  <X className="h-3.5 w-3.5 mr-1" />
                  取消
                </Button>
              </div>
            )}
          </div>

          <div className="card-flip-back rounded-xl border border-amber/40 bg-card-warm p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-[11px] px-2 py-0.5 rounded-full font-medium bg-amber-soft text-amber">
                答案
              </span>
              <span className="text-[10px] tabular-nums text-muted-foreground/60 font-mono">
                #{String(index + 1).padStart(2, '0')}
              </span>
            </div>
            <div
              className="text-[14px] leading-relaxed text-ink"
              dangerouslySetInnerHTML={{
                __html: isCloze
                  ? renderClozeText(card.question, true)
                  : escapeHtml(card.answer || '（无答案）').replace(/\n/g, '<br/>'),
              }}
            />
            <div className="mt-3 text-[11px] text-muted-foreground/50">
              点击卡片返回
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
