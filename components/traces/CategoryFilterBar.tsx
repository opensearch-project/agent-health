/**
 * CategoryFilterBar
 *
 * Filter buttons for filtering spans by category (AGENT, LLM, TOOL).
 */

import React from 'react';
import { Bot, Zap, Wrench, Filter } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { SpanCategory } from '@/types';

interface CategoryFilterBarProps {
  selectedCategories: SpanCategory[];
  onChange: (categories: SpanCategory[]) => void;
  counts?: Record<SpanCategory, number>;
  className?: string;
}

interface FilterButton {
  category: SpanCategory;
  label: string;
  icon: React.ReactNode;
  activeClass: string;
}

const FILTER_BUTTONS: FilterButton[] = [
  {
    category: 'AGENT',
    label: 'Agent',
    icon: <Bot size={14} />,
    activeClass: 'bg-indigo-500/20 text-indigo-400 border-indigo-500/50',
  },
  {
    category: 'LLM',
    label: 'LLM',
    icon: <Zap size={14} />,
    activeClass: 'bg-purple-500/20 text-purple-400 border-purple-500/50',
  },
  {
    category: 'TOOL',
    label: 'Tool',
    icon: <Wrench size={14} />,
    activeClass: 'bg-amber-500/20 text-amber-400 border-amber-500/50',
  },
];

const CategoryFilterBar: React.FC<CategoryFilterBarProps> = ({
  selectedCategories,
  onChange,
  counts,
  className,
}) => {
  const isAllSelected = selectedCategories.length === 0;

  const handleToggle = (category: SpanCategory) => {
    if (selectedCategories.includes(category)) {
      // Remove category
      onChange(selectedCategories.filter(c => c !== category));
    } else {
      // Add category
      onChange([...selectedCategories, category]);
    }
  };

  const handleSelectAll = () => {
    onChange([]);
  };

  return (
    <div className={cn('flex items-center gap-2 p-2', className)}>
      <Filter size={14} className="text-muted-foreground" />

      {/* All button */}
      <Button
        variant="outline"
        size="sm"
        className={cn(
          'h-7 px-2 text-xs gap-1.5',
          isAllSelected && 'bg-primary/10 text-primary border-primary/50'
        )}
        onClick={handleSelectAll}
      >
        All
      </Button>

      {/* Category filter buttons */}
      {FILTER_BUTTONS.map(({ category, label, icon, activeClass }) => {
        const isActive = selectedCategories.includes(category);
        const count = counts?.[category];

        return (
          <Button
            key={category}
            variant="outline"
            size="sm"
            className={cn(
              'h-7 px-2 text-xs gap-1.5',
              isActive && activeClass
            )}
            onClick={() => handleToggle(category)}
          >
            {icon}
            <span>{label}</span>
            {count !== undefined && count > 0 && (
              <span className="text-[10px] opacity-70">({count})</span>
            )}
          </Button>
        );
      })}
    </div>
  );
};

export default CategoryFilterBar;
