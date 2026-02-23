# Design Document

## Overview

This design document outlines the systematic approach to cleaning up and standardizing the UI look and feel across the Agent Health application. The cleanup will be organized into logical phases, focusing on establishing consistent patterns that can be applied across all components.

## Design Principles

### 1. Style Guide as Source of Truth

All UI decisions should reference the existing `style-guide.html` file, which defines:
- Color schemes for badges, alerts, and metrics
- Typography scales and weights
- Spacing patterns
- Component patterns

### 2. Incremental Improvement

Changes will be made incrementally, page by page and component by component, to:
- Minimize risk of breaking existing functionality
- Allow for testing and validation at each step
- Enable easy rollback if issues arise

### 3. Consistency Over Novelty

When faced with multiple existing patterns for the same purpose, choose the pattern that:
- Aligns best with the style guide
- Is most commonly used across the application
- Provides the best user experience

### 4. Accessibility First

All UI changes must maintain or improve accessibility:
- Maintain WCAG AA color contrast ratios
- Preserve keyboard navigation
- Keep semantic HTML structure
- Include appropriate ARIA attributes

## Architecture

### Component Hierarchy

```
App (Theme Provider)
├── Layout (Navigation, Sidebar)
│   ├── Dashboard
│   ├── Benchmarks Pages
│   ├── Test Cases Pages
│   ├── Reports Pages
│   └── Traces Pages
│       ├── AgentTracesPage (Main table view)
│       ├── TraceFlyoutContent (Detail panel)
│       ├── MetricsOverview (Charts)
│       └── TraceInfoView (Info tab)
└── UI Components (shadcn/ui)
    ├── Card, CardHeader, CardContent
    ├── Button, Badge, Input, Select
    ├── Table components
    └── Alert, Skeleton components
```

### Style System

```
Tailwind Config
├── Colors
│   ├── opensearch-blue: #005EB8
│   ├── Semantic colors (success, error, warning, info)
│   └── Neutral grays (slate scale)
├── Spacing Scale
│   ├── 0, 1, 2, 3, 4, 6, 8, 12, 16, 24
│   └── Applied via p-*, m-*, gap-* utilities
├── Typography Scale
│   ├── text-xs (0.75rem)
│   ├── text-sm (0.875rem)
│   ├── text-base (1rem)
│   ├── text-lg (1.125rem)
│   └── text-2xl (1.5rem)
└── Component Variants
    ├── Button (default, outline, destructive, ghost)
    ├── Badge (default, secondary, outline)
    └── Card (default with border)
```

## Detailed Design

### Phase 1: Foundation - Typography and Spacing

#### Typography Standardization

**Page Headers**
```tsx
// Before (inconsistent)
<h2 className="text-3xl font-semibold">
<h2 className="text-xl font-bold">

// After (standardized)
<h2 className="text-2xl font-bold">
```

**Section Headers**
```tsx
// Before (inconsistent)
<h3 className="text-base font-bold">
<div className="text-lg font-semibold">

// After (standardized)
<h3 className="text-lg font-semibold">
```

**Body Text**
```tsx
// Before (inconsistent)
<p className="text-base">
<span className="text-sm">

// After (standardized)
<p className="text-sm">  // Standard body text
<span className="text-xs text-muted-foreground">  // Secondary text
```

#### Spacing Standardization

**Page Layout**
```tsx
// Before (inconsistent)
<div className="p-4">
<div className="p-8">

// After (standardized)
<div className="p-6">  // Main page padding
```

**Card Padding**
```tsx
// Before (inconsistent)
<CardContent className="p-6">
<CardContent className="p-3">

// After (standardized)
<CardHeader className="p-4 pb-4">
<CardContent className="p-4">
```

**Element Spacing**
```tsx
// Before (inconsistent)
<div className="space-y-3">
<div className="gap-3">

// After (standardized)
<div className="space-y-4">  // Vertical sections
<div className="gap-2">      // Inline elements
<div className="gap-4">      // Form fields
```

### Phase 2: Color System

#### Semantic Color Mapping

**Success States**
```tsx
// Text: green-700 dark:green-400
// Background: green-100 dark:green-500/20
// Border: green-300 dark:green-500/30

<Badge className="text-xs px-2 py-1 bg-green-100 text-green-700 border border-green-300 dark:bg-green-500/20 dark:text-green-400 dark:border-green-500/30 rounded">
  PASSED
</Badge>
```

**Error States**
```tsx
// Text: red-700 dark:red-400
// Background: red-100 dark:red-500/20
// Border: red-300 dark:red-500/30

<Badge className="text-xs px-2 py-1 bg-red-100 text-red-700 border border-red-300 dark:bg-red-500/20 dark:text-red-400 dark:border-red-500/30 rounded">
  FAILED
</Badge>
```

**Warning States**
```tsx
// Text: amber-700 dark:amber-400
// Background: amber-100 dark:amber-500/20
// Border: amber-300 dark:amber-500/30

<Badge className="text-xs px-2 py-1 bg-amber-100 text-amber-700 border border-amber-300 dark:bg-amber-500/20 dark:text-amber-400 dark:border-amber-500/30 rounded">
  PENDING
</Badge>
```

**Info States**
```tsx
// Text: blue-700 dark:blue-400
// Background: blue-100 dark:blue-500/20
// Border: blue-300 dark:blue-500/30

<Badge className="text-xs px-2 py-1 bg-blue-100 text-blue-700 border border-blue-300 dark:bg-blue-500/20 dark:text-blue-400 dark:border-blue-500/30 rounded">
  Running
</Badge>
```

#### Brand Color Usage

**Primary Actions and Highlights**
```tsx
// Use opensearch-blue for primary brand elements
<Activity size={13} className="text-opensearch-blue" />
<span className="font-semibold text-opensearch-blue">{count}</span>
```

### Phase 3: Component Patterns

#### Badge Component Pattern

```tsx
// Status Badge (with border)
<Badge className="text-xs px-2 py-1 bg-{color}-100 text-{color}-700 border border-{color}-300 dark:bg-{color}-500/20 dark:text-{color}-400 dark:border-{color}-500/30 rounded">
  {status}
</Badge>

// Category Pill (span categories)
<Badge className="text-xs px-2 py-1 bg-purple-100 text-purple-700 border border-purple-300 dark:bg-purple-500/10 dark:text-purple-400 dark:border-purple-500/30 rounded">
  LLM
</Badge>

// Count Badge (secondary)
<Badge variant="secondary" className="text-xs">
  {count}
</Badge>
```

#### Metric Card Pattern

```tsx
<div className="p-4 bg-slate-50 dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800">
  <div className="text-[10px] text-slate-600 dark:text-slate-400 mb-1">
    {label}
  </div>
  <div className="text-xs font-semibold text-{semantic}-700 dark:text-{semantic}-400">
    {value}
  </div>
</div>
```

#### Alert Pattern

```tsx
// Error Alert
<Alert className="bg-red-50 dark:bg-red-500/10 border-red-300 dark:border-red-500/30">
  <AlertCircle className="h-4 w-4 text-red-700 dark:text-red-400" />
  <AlertTitle className="text-red-700 dark:text-red-400">Error</AlertTitle>
  <AlertDescription className="text-sm text-slate-600 dark:text-slate-400">
    {message}
  </AlertDescription>
</Alert>

// Warning Alert
<Alert className="bg-yellow-50 dark:bg-yellow-500/10 border-yellow-300 dark:border-yellow-500/30">
  <AlertCircle className="h-4 w-4 text-yellow-700 dark:text-yellow-400" />
  <AlertTitle className="text-yellow-700 dark:text-yellow-400">Warning</AlertTitle>
  <AlertDescription className="text-sm text-slate-600 dark:text-slate-400">
    {message}
  </AlertDescription>
</Alert>
```

#### Table Pattern

```tsx
<table className="w-full caption-bottom text-sm">
  <thead className="sticky top-0 z-10 bg-background">
    <tr className="border-b">
      <th className="h-12 px-4 text-left align-middle font-medium text-muted-foreground bg-background">
        Column Header
      </th>
    </tr>
  </thead>
  <tbody>
    <tr className="border-b transition-colors cursor-pointer hover:bg-muted/50 data-[state=selected]:bg-muted/70">
      <td className="p-4 align-middle text-sm">
        Cell Content
      </td>
    </tr>
  </tbody>
</table>
```

### Phase 4: Page-Specific Cleanup

#### AgentTracesPage

**Current Issues:**
- Unused imports (CardHeader, CardTitle, isCollapsed)
- Inconsistent metric display styling
- Mixed spacing values

**Cleanup Plan:**
1. Remove unused imports
2. Standardize inline metrics to use consistent icon sizing (size={13})
3. Apply metric card pattern to MetricsOverview component
4. Ensure consistent gap spacing (gap-2 for inline, gap-4 for sections)
5. Standardize badge usage for status and counts

#### Dashboard

**Current Issues:**
- Inconsistent card header styling
- Mixed typography scales
- Varying spacing between sections

**Cleanup Plan:**
1. Standardize CardHeader padding (p-4 pb-4)
2. Apply consistent text sizing (text-lg for card titles, text-sm for descriptions)
3. Ensure consistent spacing between cards (space-y-8)
4. Standardize filter chip styling
5. Apply consistent skeleton loading patterns

#### Other Pages

Similar cleanup patterns will be applied to:
- BenchmarksPage
- TestCasesPage
- ReportsPage
- RunDetailsPage
- SettingsPage

### Phase 5: Component Library Cleanup

#### Button Consistency

```tsx
// Small buttons (compact UI)
<Button size="sm" className="h-8">
  <Icon size={14} />
  Label
</Button>

// Default buttons
<Button>
  <Icon size={16} />
  Label
</Button>

// Icon-only buttons
<Button variant="outline" size="sm" className="h-8 w-8 p-0">
  <Icon size={16} />
</Button>
```

#### Form Element Consistency

```tsx
// Compact forms
<Input className="h-8 text-sm" />
<Select>
  <SelectTrigger className="h-8 text-sm">
    <SelectValue />
  </SelectTrigger>
</Select>

// Default forms
<Input className="h-10" />
<Select>
  <SelectTrigger className="h-10">
    <SelectValue />
  </SelectTrigger>
</Select>
```

## Implementation Strategy

### Phase Execution Order

1. **Phase 1: Foundation** (Typography & Spacing)
   - Update all page headers to text-2xl font-bold
   - Update all section headers to text-lg font-semibold
   - Standardize body text to text-sm
   - Apply consistent page padding (p-6)
   - Apply consistent card padding (p-4)
   - Standardize gap spacing (gap-2, gap-4)

2. **Phase 2: Color System**
   - Update all success states to green color scheme
   - Update all error states to red color scheme
   - Update all warning states to amber color scheme
   - Update all info states to blue color scheme
   - Apply opensearch-blue to brand elements
   - Ensure dark mode variants for all colors

3. **Phase 3: Component Patterns**
   - Standardize all badge components
   - Standardize all metric card displays
   - Standardize all alert components
   - Standardize all table styling
   - Apply consistent button patterns

4. **Phase 4: Page-Specific Cleanup**
   - Clean up AgentTracesPage
   - Clean up Dashboard
   - Clean up Benchmarks pages
   - Clean up Test Cases pages
   - Clean up Reports pages
   - Clean up Settings page

5. **Phase 5: Component Library**
   - Review and update all UI components
   - Remove unused component code
   - Ensure consistent prop patterns
   - Update component documentation

### Testing Strategy

#### Visual Regression Testing

1. Take screenshots of all pages before changes
2. Apply changes incrementally
3. Take screenshots after each phase
4. Compare before/after screenshots
5. Verify no unintended visual changes

#### Functional Testing

1. Test all interactive elements (buttons, forms, tables)
2. Verify keyboard navigation works
3. Test responsive behavior at all breakpoints
4. Verify dark mode switching works correctly
5. Test with screen readers for accessibility

#### Performance Testing

1. Measure page load times before and after
2. Verify no performance regressions
3. Check bundle size impact
4. Monitor React rendering performance

## Migration Guide

### For Developers

When adding new components or features:

1. **Reference the Style Guide**
   - Check `style-guide.html` for color schemes
   - Use defined badge patterns
   - Use defined alert patterns
   - Use defined metric card patterns

2. **Follow Spacing Standards**
   - Use p-6 for page padding
   - Use p-4 for card padding
   - Use gap-2 for inline elements
   - Use gap-4 for form fields
   - Use space-y-4 or space-y-8 for sections

3. **Follow Typography Standards**
   - Use text-2xl font-bold for page headers
   - Use text-lg font-semibold for section headers
   - Use text-sm for body text
   - Use text-xs text-muted-foreground for labels

4. **Follow Color Standards**
   - Use semantic color schemes (green, red, amber, blue)
   - Include dark mode variants
   - Use opensearch-blue for brand elements
   - Use text-muted-foreground for secondary text

5. **Use Component Library**
   - Use shadcn/ui components
   - Don't create custom styled divs
   - Follow component prop patterns
   - Remove unused imports

## Success Criteria

### Quantitative Metrics

- [ ] 80% reduction in unique spacing values
- [ ] 70% reduction in unique color values
- [ ] 95% style guide pattern compliance
- [ ] 100% removal of unused code
- [ ] WCAG AA accessibility compliance
- [ ] No performance regressions

### Qualitative Metrics

- [ ] Consistent visual hierarchy across all pages
- [ ] Professional and polished appearance
- [ ] Improved user experience
- [ ] Easier maintenance for developers
- [ ] Clear and consistent design language

## Risks and Mitigation

### Risk: Breaking Existing Functionality

**Mitigation:**
- Make changes incrementally
- Test thoroughly after each change
- Use version control for easy rollback
- Review changes with team before merging

### Risk: Inconsistent Application of Standards

**Mitigation:**
- Create clear documentation
- Use linting rules to enforce patterns
- Conduct code reviews
- Maintain style guide as single source of truth

### Risk: Performance Impact

**Mitigation:**
- Monitor bundle size
- Test page load times
- Profile React rendering
- Optimize where necessary

### Risk: Accessibility Regressions

**Mitigation:**
- Test with screen readers
- Verify keyboard navigation
- Check color contrast ratios
- Follow WCAG guidelines

## Timeline

- **Phase 1 (Foundation):** 2-3 days
- **Phase 2 (Color System):** 2-3 days
- **Phase 3 (Component Patterns):** 3-4 days
- **Phase 4 (Page Cleanup):** 4-5 days
- **Phase 5 (Component Library):** 2-3 days
- **Testing & Refinement:** 2-3 days

**Total Estimated Time:** 15-21 days

## Conclusion

This systematic approach to UI cleanup will result in a more consistent, professional, and maintainable application. By following the established style guide and applying patterns incrementally, we can improve the user experience while minimizing risk and maintaining code quality.
