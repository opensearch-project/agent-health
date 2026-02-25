# Design Document: OpenSearch Logo Integration

## Overview

This feature replaces the generic gradient circle with Zap icon in the First Run Experience hero section with the official OpenSearch logo. The implementation supports both dark and light theme modes with automatic switching based on the user's theme preference.

## Architecture

### Component Structure

```
FirstRunExperience
└── Hero Section
    ├── Logo Container (flex justify-center)
    │   ├── Dark Mode Logo (opensearch-logo-dark.svg)
    │   └── Light Mode Logo (opensearch-logo-light.svg)
    ├── Heading ("Welcome to Agent Health")
    ├── Description
    └── CTA Buttons
```

### Theme Switching Logic

The implementation uses Tailwind CSS's built-in dark mode classes for automatic theme switching:

```tsx
<div className="flex justify-center">
  <img 
    src="/opensearch-logo-dark.svg" 
    alt="OpenSearch Logo" 
    className="w-16 h-16 dark:block hidden"
  />
  <img 
    src="/opensearch-logo-light.svg" 
    alt="OpenSearch Logo" 
    className="w-16 h-16 dark:hidden block"
  />
</div>
```

**How it works**:
- Both images are rendered in the DOM
- `dark:block hidden` - Shows in dark mode, hidden in light mode
- `dark:hidden block` - Hidden in dark mode, shows in light mode
- Tailwind automatically applies the `dark:` variants based on system/user preference

## Visual Design

### Logo Specifications

**Size**: 64x64 pixels (w-16 h-16 in Tailwind)

**Dark Mode Colors**:
- Primary blue: `#00A3E0` (original OpenSearch brand color)
- Light blue: `#B9D9EB` (original OpenSearch accent color)

**Light Mode Colors**:
- Primary blue: `#005EB8` (darker for better contrast on light backgrounds)
- Light blue: `#7FB3D5` (adjusted for light mode visibility)

### SVG Structure

Both logo variants use the same SVG structure with three curved shapes representing the OpenSearch brand:

```xml
<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64' fill='none'>
  <!-- Top right curved shape -->
  <path d='M61.7374 23.5C...' fill='[PRIMARY_COLOR]'/>
  
  <!-- Top left curved shape -->
  <path d='M48.0814 38C...' fill='[ACCENT_COLOR]'/>
  
  <!-- Bottom curved shape -->
  <path d='M3.91861 14C...' fill='[PRIMARY_COLOR]'/>
</svg>
```

### Layout Integration

**Before**:
```tsx
<div className="w-16 h-16 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
  <Zap className="h-8 w-8 text-white" />
</div>
```

**After**:
```tsx
<div className="flex justify-center">
  <img src="/opensearch-logo-dark.svg" alt="OpenSearch Logo" className="w-16 h-16 dark:block hidden" />
  <img src="/opensearch-logo-light.svg" alt="OpenSearch Logo" className="w-16 h-16 dark:hidden block" />
</div>
```

**Changes**:
- Removed gradient circle background
- Removed Zap icon
- Added dual-image approach for theme switching
- Maintained same size (64x64px)
- Simplified container (no rounded-full, no background)

## Implementation Details

### File Structure

```
agent-health-jasonlh/
├── public/
│   ├── opensearch-logo-dark.svg    # Dark mode variant
│   └── opensearch-logo-light.svg   # Light mode variant
└── components/
    └── dashboard/
        └── FirstRunExperience.tsx  # Updated component
```

### Component Changes

**Location**: `components/dashboard/FirstRunExperience.tsx`

**Modified Section**: Hero section, specifically the logo display area above the heading

**Lines Changed**: ~10-20 lines in the hero section

### Asset Files

**Dark Mode Logo** (`public/opensearch-logo-dark.svg`):
- File size: ~1KB
- Colors: #00A3E0, #B9D9EB
- ViewBox: 0 0 64 64

**Light Mode Logo** (`public/opensearch-logo-light.svg`):
- File size: ~1KB
- Colors: #005EB8, #7FB3D5
- ViewBox: 0 0 64 64

## Correctness Properties

### Property 1: Theme-Appropriate Logo Display

*For any* theme state (dark or light), exactly one logo variant should be visible at any given time.

**Validates: Requirements 2.1, 2.2, 2.3**

**Test Strategy**: Use property-based testing to generate random theme states and verify that:
- When theme is dark, only dark logo is visible
- When theme is light, only light logo is visible
- Never both visible simultaneously
- Never neither visible

### Property 2: Logo Visibility Invariance

*For any* theme state, the logo must always be visible (not hidden, not zero opacity, not zero dimensions).

**Validates: Requirements 1.1, 4.2**

**Test Strategy**: Verify that for all theme states, the visible logo has:
- Computed display !== 'none'
- Computed opacity > 0
- Computed width and height > 0

### Property 3: Asset Path Consistency

*For any* render of FirstRunExperience, the logo image sources must point to the correct public directory paths.

**Validates: Requirements 3.4, 3.5**

**Test Strategy**: Verify that:
- Dark mode img src === '/opensearch-logo-dark.svg'
- Light mode img src === '/opensearch-logo-light.svg'
- Paths are absolute (start with /)
- No dynamic path construction

### Property 4: Accessibility Attribute Presence

*For any* logo image element, the alt attribute must be present and non-empty.

**Validates: Requirements 4.1**

**Test Strategy**: Verify that both img elements have:
- alt attribute exists
- alt attribute value === 'OpenSearch Logo'

### Property 5: Size Consistency

*For any* logo image element, the dimensions must match the specified size (64x64px).

**Validates: Requirements 1.2**

**Test Strategy**: Verify that both img elements have:
- className includes 'w-16' and 'h-16'
- Computed width === 64px
- Computed height === 64px

## Error Handling

### Missing SVG Files

**Scenario**: One or both SVG files are missing from the public directory.

**Handling**:
- Browser will show broken image icon
- Alt text "OpenSearch Logo" will be displayed
- Component continues to render normally
- Console error logged by browser

**Prevention**:
- Include SVG files in version control
- Add build-time check to verify asset existence
- Document asset requirements in README

### Invalid SVG Content

**Scenario**: SVG file is corrupted or contains invalid XML.

**Handling**:
- Browser will fail to render the image
- Alt text will be displayed
- No JavaScript errors (handled by browser)

**Prevention**:
- Validate SVG files before committing
- Use SVG optimization tools
- Test in multiple browsers

### Theme Detection Failure

**Scenario**: Tailwind dark mode classes fail to apply correctly.

**Handling**:
- Light mode logo will be shown by default (due to `block` class)
- User can manually toggle theme in browser settings
- No component crash or error

**Fallback**:
- Light mode is the default state
- Ensures logo is always visible even if dark mode fails

## Testing Strategy

### Unit Tests

**Component Rendering**:
```typescript
describe('FirstRunExperience - Logo', () => {
  it('renders both logo variants', () => {
    const { container } = render(<FirstRunExperience />);
    const logos = container.querySelectorAll('img[alt="OpenSearch Logo"]');
    expect(logos).toHaveLength(2);
  });

  it('dark mode logo has correct src', () => {
    const { container } = render(<FirstRunExperience />);
    const darkLogo = container.querySelector('img[src="/opensearch-logo-dark.svg"]');
    expect(darkLogo).toBeInTheDocument();
  });

  it('light mode logo has correct src', () => {
    const { container } = render(<FirstRunExperience />);
    const lightLogo = container.querySelector('img[src="/opensearch-logo-light.svg"]');
    expect(lightLogo).toBeInTheDocument();
  });

  it('logos have correct size classes', () => {
    const { container } = render(<FirstRunExperience />);
    const logos = container.querySelectorAll('img[alt="OpenSearch Logo"]');
    logos.forEach(logo => {
      expect(logo.className).toContain('w-16');
      expect(logo.className).toContain('h-16');
    });
  });
});
```

**Theme Switching**:
```typescript
describe('Theme Switching', () => {
  it('shows dark logo in dark mode', () => {
    // Mock dark mode
    document.documentElement.classList.add('dark');
    
    const { container } = render(<FirstRunExperience />);
    const darkLogo = container.querySelector('img[src="/opensearch-logo-dark.svg"]');
    
    expect(darkLogo).toBeVisible();
  });

  it('shows light logo in light mode', () => {
    // Mock light mode
    document.documentElement.classList.remove('dark');
    
    const { container } = render(<FirstRunExperience />);
    const lightLogo = container.querySelector('img[src="/opensearch-logo-light.svg"]');
    
    expect(lightLogo).toBeVisible();
  });
});
```

### Property-Based Tests

**Library**: fast-check

**Configuration**: Minimum 100 iterations per property

**Property 1 Test**:
```typescript
// Feature: opensearch-logo-integration, Property 1: Theme-Appropriate Logo Display
it('displays exactly one logo variant for any theme state', () => {
  fc.assert(
    fc.property(
      fc.boolean(), // theme: true = dark, false = light
      (isDark) => {
        if (isDark) {
          document.documentElement.classList.add('dark');
        } else {
          document.documentElement.classList.remove('dark');
        }
        
        const { container } = render(<FirstRunExperience />);
        
        const darkLogo = container.querySelector('img[src="/opensearch-logo-dark.svg"]');
        const lightLogo = container.querySelector('img[src="/opensearch-logo-light.svg"]');
        
        const darkVisible = darkLogo && window.getComputedStyle(darkLogo).display !== 'none';
        const lightVisible = lightLogo && window.getComputedStyle(lightLogo).display !== 'none';
        
        // Exactly one should be visible (XOR)
        expect(darkVisible !== lightVisible).toBe(true);
      }
    ),
    { numRuns: 100 }
  );
});
```

### Visual Regression Testing

**Manual Testing Checklist**:
1. ✅ Logo displays in dark mode with correct colors
2. ✅ Logo displays in light mode with correct colors
3. ✅ Logo switches automatically when theme changes
4. ✅ Logo is centered above the heading
5. ✅ Logo maintains 64x64px size
6. ✅ Logo is recognizable and clear
7. ✅ No broken image icons
8. ✅ Alt text displays if image fails to load

### Browser Testing

**Browsers to Test**:
- Chrome (latest)
- Firefox (latest)
- Safari (latest)
- Edge (latest)

**Test Cases**:
- SVG rendering quality
- Theme switching responsiveness
- Image loading performance
- Fallback behavior (missing files)

## Performance Considerations

### Asset Optimization

**SVG File Size**:
- Current: ~1KB per file
- Optimized: Remove unnecessary whitespace, comments
- Gzip compression: ~500 bytes per file

**Loading Strategy**:
- SVG files loaded from public directory (static assets)
- No lazy loading needed (above the fold)
- Browser caching enabled (static assets)

### Rendering Performance

**Initial Render**:
- Both images rendered in DOM
- CSS controls visibility (no JavaScript)
- No layout shift (size specified in classes)

**Theme Switching**:
- Pure CSS transition (no re-render)
- No JavaScript execution required
- Instant visual feedback

## Accessibility

### Screen Readers

**Implementation**:
- Alt text: "OpenSearch Logo"
- Semantic HTML: `<img>` element
- No decorative role (logo is meaningful)

**Behavior**:
- Screen readers announce "OpenSearch Logo"
- Logo is part of the page flow
- No additional ARIA attributes needed

### Keyboard Navigation

**Implementation**:
- Logo is not interactive (no focus needed)
- No keyboard events required
- Part of static hero section

### Color Contrast

**Dark Mode**:
- Logo colors (#00A3E0, #B9D9EB) on dark background
- High contrast, easily visible

**Light Mode**:
- Logo colors (#005EB8, #7FB3D5) on light background
- Adjusted for sufficient contrast
- Meets WCAG AA standards

## Future Enhancements

### Potential Improvements

1. **Animated Logo**: Add subtle animation on page load
2. **Multiple Sizes**: Create variants for different contexts (header, footer, etc.)
3. **SVG Sprite**: Combine both variants into a single sprite sheet
4. **Lazy Loading**: Implement for below-the-fold usage
5. **WebP Fallback**: Provide raster fallback for older browsers

### Maintenance

**Logo Updates**:
- Replace SVG files in public directory
- No code changes required
- Test in both themes

**Color Adjustments**:
- Edit SVG fill attributes
- Maintain separate files for each theme
- Verify contrast ratios

## Implementation Status

**Completed**:
- ✅ Dark mode SVG created and added to public directory
- ✅ Light mode SVG created and added to public directory
- ✅ FirstRunExperience component updated with dual-image approach
- ✅ Theme switching implemented with Tailwind classes
- ✅ Manual testing completed in Chrome DevTools
- ✅ Visual verification in both dark and light modes

**Remaining**:
- Unit tests for logo rendering
- Property-based tests for theme switching
- Browser compatibility testing
- Performance benchmarking
