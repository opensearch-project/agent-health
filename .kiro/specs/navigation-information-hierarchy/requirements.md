# Navigation and Information Hierarchy Improvement

## Overview
Restructure the Agent Health application's navigation and home page to better align with actual user workflows while addressing the tension between ideal testing methodology and real-world usage patterns.

## Critical Challenges to the Proposed Approach

### Challenge 1: The "Ideal vs. Real" Workflow Gap
**The Assumption:** Users follow Define → Prepare → Run → Judge linearly.

**The Reality:** Based on the user journey document, actual usage patterns show:
- **Developers (Primary persona):** Start with Traces FIRST to debug existing issues, then work backwards to create test cases
- **QA Engineers:** May start with Test Cases, but often iterate between Test Cases and running evaluations
- **SREs:** Jump directly to Live Traces for production monitoring, rarely touch Benchmarks
- **First-time users:** Start with Demo Mode and explore Traces immediately (30-second time-to-value)

**The Problem:** Forcing Benchmarks first assumes users start from scratch with a testing mindset. Most users arrive with a problem to solve (debugging, monitoring) or want to explore existing data first.

**Question for Consideration:** Should navigation optimize for the "ideal" workflow or the "actual" workflow? What if these conflict?

### Challenge 2: The "Overview" Page Paradox
**The Assumption:** A home page explanation panel helps users understand the product.

**The Reality:** 
- Current navigation has "Overview" as the first item (Dashboard)
- User journey shows 30-second time-to-value with immediate trace visualization
- Adding explanation panels increases cognitive load before users see value
- Return users (80% of traffic after week 1) will find persistent explanations annoying

**The Problem:** Explanation panels work for complex products, but Agent Health's value is immediate and visual. The user journey emphasizes "Low Friction" and "30-second setup" - adding explanation contradicts this.

**Question for Consideration:** Do users need explanation, or do they need to see traces immediately and understand through interaction?

### Challenge 3: The "Benchmarks First" Assumption
**The Assumption:** Users need to define "good" before testing.

**The Reality:**
- Benchmarks are an advanced feature for mature testing practices
- User journey shows Benchmarks are NOT mentioned in Stage 3 (First Run) or Stage 4 (Dashboard Exploration)
- Only QA Engineers and PMs use Benchmarks systematically
- Developers and SREs (primary personas) rarely create formal benchmarks

**The Problem:** Putting Benchmarks first optimizes for a minority use case (formal QA) while making the majority use case (debugging, monitoring) harder to access.

**Question for Consideration:** Should navigation prioritize the most common use case (Traces) or the most "correct" methodology (Benchmarks)?

### Challenge 4: The "Traces vs. Evaluations" Confusion
**The Assumption:** Traces and Evaluations are separate concepts.

**The Reality:**
- Current navigation has "Agent Traces" as a top-level item
- "Evals" is a collapsible section containing "Test Cases" and "Benchmarks"
- Evaluations (results) are shown within Benchmark runs, not as a separate page
- Users think of "running evaluations" as an action, not a destination

**The Problem:** Creating a separate "Evaluations" nav item may not match the actual information architecture. Evaluation results are contextual to Benchmarks and Test Cases, not standalone.

**Question for Consideration:** Is "Evaluations" a top-level navigation item, or is it a view within Benchmarks/Test Cases?

### Challenge 5: The "Return User" Problem
**The Assumption:** Navigation should serve first-time users equally with return users.

**The Reality:**
- After week 1, 80% of users are return users with established workflows
- Return users have muscle memory for current navigation
- Changing navigation order disrupts existing workflows
- User journey shows different personas have different primary destinations

**The Problem:** Optimizing for first-time users may harm the experience for the majority of actual users.

**Question for Consideration:** Should we optimize for onboarding or for daily usage? Can we do both?

## Refined User Stories (Return User Focused)

### 1. As a return user, I want to reach my primary destination quickly
**Acceptance Criteria:**
- Navigation maintains current structure with minimal changes
- Traces remain in top 3 positions (currently #2, stays #2)
- No additional clicks required to reach frequently-used sections
- Keyboard shortcuts and URL patterns remain unchanged

**Priority:** P0 (Critical)

### 2. As a developer debugging an agent, I want immediate access to traces
**Acceptance Criteria:**
- Agent Traces is the second item in navigation (after Overview)
- Direct link without nested navigation
- Route remains `/agent-traces`
- No forced workflow steps before accessing traces

**Priority:** P0 (Critical)

### 3. As a QA engineer, I want testing features grouped logically
**Acceptance Criteria:**
- Benchmarks and Test Cases are grouped under "Testing" section
- Section is collapsible but expanded by default
- Visual hierarchy shows relationship between Benchmarks and Test Cases
- Both items remain directly accessible (no extra clicks when expanded)

**Priority:** P1 (High)

### 4. As a new user, I want to understand section purposes without blocking my workflow
**Acceptance Criteria:**
- Navigation items have optional hover tooltips
- Tooltips provide brief context:
  - Overview: "Dashboard and quick stats"
  - Agent Traces: "View and debug agent executions"
  - Testing: "Benchmarks and test cases"
  - Benchmarks: "Define success criteria"
  - Test Cases: "Create and manage test inputs"
- Tooltips are non-intrusive and don't block interaction
- No modal dialogs or blocking explanation panels

**Priority:** P1 (High)

### 5. As a return user, I want the Overview page to show actionable information
**Acceptance Criteria:**
- Overview page shows recent activity and quick stats
- No persistent explanation panels that take up screen space
- Optional "What's New" or "Tips" can be dismissed permanently
- Focus on data and actions, not product explanation

**Priority:** P1 (High)

### 6. As any user, I want navigation that reveals conceptual relationships
**Acceptance Criteria:**
- "Testing" group visually indicates Benchmarks and Test Cases are related
- Grouping uses subtle visual cues (indentation, spacing, icons)
- Structure teaches relationships without explicit explanation
- Collapsible sections allow users to hide what they don't use

**Priority:** P2 (Medium)

### 7. As a power user, I want efficient navigation
**Acceptance Criteria:**
- Sidebar can collapse to icon-only mode (already exists)
- Search functionality works across all navigation items (already exists)
- Keyboard navigation supported
- Recent/favorite sections easily accessible

**Priority:** P2 (Medium)

## Alternative Navigation Proposals

### Option A: Usage-Based Order (Optimizes for Actual Behavior)
1. Overview (Dashboard with quick stats)
2. Agent Traces (Primary use case: debugging, monitoring)
3. Evals (Collapsible)
   - Test Cases
   - Benchmarks
4. Settings

**Pros:** Matches actual usage patterns, preserves current structure, low disruption
**Cons:** Doesn't teach "ideal" workflow, Benchmarks buried

### Option B: Hybrid Approach (Balances Ideal and Real)
1. Overview (Dashboard with workflow guidance)
2. Evals (Expanded by default)
   - Benchmarks (with "Start here" indicator)
   - Test Cases
3. Agent Traces
4. Settings

**Pros:** Teaches workflow while keeping traces accessible, minimal disruption
**Cons:** Still forces extra clicks to reach traces

### Option C: Persona-Based Navigation (Optimizes for Multiple Workflows)
1. Overview (Dashboard with persona-based quick actions)
2. Agent Traces (with "Debug" and "Monitor" sub-sections)
3. Testing (Collapsible)
   - Test Cases
   - Benchmarks
   - Reports
4. Settings

**Pros:** Serves multiple personas, groups related concepts, clear purpose
**Cons:** More complex, requires new "Reports" consolidation

### Option D: Your Proposed Order (Optimizes for Ideal Workflow)
1. Overview (with product explanation)
2. Benchmarks
3. Test Cases
4. Traces
5. Evaluations (new page)
6. Settings

**Pros:** Teaches ideal workflow, clear progression, good for QA-focused teams
**Cons:** Disrupts primary use case, adds friction, may frustrate developers/SREs

## Questions Requiring User Input

1. ✅ **Primary Optimization Target:** Return users (DECIDED)

2. ✅ **Persona Priority:** Balanced approach - preserve developer/SRE access to Traces while improving QA discoverability (DECIDED)

3. ✅ **Explanation Strategy:** Progressive (contextual tooltips) and optional (dismissible tips), not upfront blocking panels (DECIDED)

4. ✅ **Evaluations Architecture:** Integrated into Test Cases and Benchmarks, not a separate page (DECIDED)

5. ✅ **Disruption Tolerance:** Minimal - regroup and rename only, preserve all routes and core structure (DECIDED)

## Implementation Scope

### In Scope:
1. **Navigation Restructuring:**
   - Rename "Evals" to "Testing" for clarity
   - Keep Benchmarks and Test Cases as sub-items
   - Maintain collapsible structure (expanded by default)
   - Preserve all existing routes and URLs

2. **Tooltip Enhancement:**
   - Add descriptive tooltips to all navigation items
   - Ensure tooltips are accessible and non-intrusive
   - Use consistent tooltip styling

3. **Overview Page Enhancement:**
   - Ensure Overview shows actionable data, not explanation
   - Add optional dismissible "Tips" section if needed
   - Focus on recent activity and quick stats

4. **Visual Hierarchy:**
   - Use subtle visual cues for grouping (indentation, spacing)
   - Maintain existing icon system
   - Ensure collapsed state works with new structure

### Out of Scope:
- Creating new "Evaluations" page (results stay contextual)
- Changing underlying data models or APIs
- Modifying individual page functionality
- Complete visual redesign
- Adding blocking explanation modals or wizards
- Changing URL structure or routing
- Removing or hiding any existing features

### Explicitly NOT Doing:
- ❌ Putting Benchmarks first in navigation
- ❌ Creating separate "Evaluations" top-level page
- ❌ Adding persistent explanation panels on Overview
- ❌ Forcing users through setup wizards
- ❌ Changing the order of Traces (stays #2)
- ❌ Breaking existing bookmarks or deep links

## Success Metrics (Return User Focused)

### Primary Metrics (Must Not Regress):
- **Time to primary destination:** Maintain or improve current baseline
- **Navigation error rate:** No increase in back-button usage or wrong-page visits
- **Task completion rate:** Maintain current rates for common tasks
- **User satisfaction:** No decrease in navigation-related feedback scores

### Secondary Metrics (Target Improvements):
- **Feature discoverability:** 20% increase in users discovering Testing section
- **Conceptual understanding:** 30% reduction in "where do I find X" support questions
- **New user onboarding:** Maintain current 30-second time-to-first-interaction
- **Return user efficiency:** 10% improvement in multi-section workflows

### Validation Metrics:
- **A/B test results:** Compare old vs. new navigation with 50/50 split
- **Heatmap analysis:** Verify Traces remains most-clicked after Overview
- **Session recordings:** Confirm no confusion or hesitation in navigation
- **User interviews:** Qualitative feedback on navigation clarity

### Rollback Criteria:
- Any primary metric regresses by >5%
- Navigation error rate increases by >10%
- Negative feedback exceeds 20% of surveyed users

## Selected Approach: Return User Optimization

**Decision:** Optimize for return users (80% of traffic after week 1) while maintaining discoverability for new users.

**Selected Option:** Modified Option A (Usage-Based Order) with enhanced information architecture

### Navigation Structure:
1. **Overview** - Dashboard with quick stats and recent activity
2. **Agent Traces** - Primary use case: debugging and monitoring (keep easily accessible)
3. **Testing** (Collapsible, expanded by default)
   - **Benchmarks** - Define success criteria
   - **Test Cases** - Create and manage inputs
4. **Settings**

### Key Principles:
1. **Preserve Muscle Memory:** Minimal disruption to existing navigation patterns
2. **Enhance Clarity:** Better labeling and grouping without changing core structure
3. **Progressive Disclosure:** Help new users through structure and tooltips, not blocking panels
4. **Respect Workflows:** Don't force ideal methodology on users with established patterns

### Why This Works:
- **Traces remain #2:** Developers and SREs can jump directly to their primary destination
- **Testing grouped:** QA users see the relationship between Benchmarks and Test Cases
- **No forced workflow:** Users can start wherever makes sense for their task
- **Low disruption:** Builds on existing structure, preserves routes and patterns
- **Clear relationships:** Grouping reveals conceptual connections without explanation overhead

## Dependencies
- Current navigation component structure (Layout.tsx)
- Existing routing configuration
- User analytics on current navigation usage patterns
- Persona distribution in actual user base

## Assumptions to Validate
- ❓ Do users actually follow Define → Prepare → Run → Judge?
- ❓ What percentage of users start with Traces vs. Test Cases?
- ❓ How often do users access Benchmarks?
- ❓ What is the persona distribution in the actual user base?
- ❓ How much navigation change can we introduce without harming adoption?
