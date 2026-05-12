---
name: Futurista Finance OS
colors:
  surface: '#10131b'
  surface-dim: '#10131b'
  surface-bright: '#363942'
  surface-container-lowest: '#0b0e16'
  surface-container-low: '#181c24'
  surface-container: '#1c2028'
  surface-container-high: '#262a32'
  surface-container-highest: '#31353d'
  on-surface: '#e0e2ed'
  on-surface-variant: '#c2c6d8'
  inverse-surface: '#e0e2ed'
  inverse-on-surface: '#2d3039'
  outline: '#8c90a1'
  outline-variant: '#414655'
  surface-tint: '#b0c6ff'
  primary: '#b0c6ff'
  on-primary: '#002d6e'
  primary-container: '#558dff'
  on-primary-container: '#002761'
  inverse-primary: '#0058ca'
  secondary: '#afc6ff'
  on-secondary: '#082e69'
  secondary-container: '#274581'
  on-secondary-container: '#98b4f8'
  tertiary: '#ffb599'
  on-tertiary: '#5a1c00'
  tertiary-container: '#f26420'
  on-tertiary-container: '#4f1800'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#d9e2ff'
  primary-fixed-dim: '#b0c6ff'
  on-primary-fixed: '#001944'
  on-primary-fixed-variant: '#00429b'
  secondary-fixed: '#d9e2ff'
  secondary-fixed-dim: '#afc6ff'
  on-secondary-fixed: '#001944'
  on-secondary-fixed-variant: '#274581'
  tertiary-fixed: '#ffdbce'
  tertiary-fixed-dim: '#ffb599'
  on-tertiary-fixed: '#370e00'
  on-tertiary-fixed-variant: '#7f2b00'
  background: '#10131b'
  on-background: '#e0e2ed'
  surface-variant: '#31353d'
typography:
  display-lg:
    fontFamily: Inter
    fontSize: 48px
    fontWeight: '700'
    lineHeight: '1.1'
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: '1.2'
  body-main:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: '1.6'
  data-mono:
    fontFamily: JetBrains Mono
    fontSize: 14px
    fontWeight: '500'
    lineHeight: '1.4'
    letterSpacing: 0.05em
  label-caps:
    fontFamily: Space Grotesk
    fontSize: 12px
    fontWeight: '700'
    lineHeight: '1'
    letterSpacing: 0.1em
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  unit: 4px
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 40px
  container-margin: 32px
  grid-gutter: 20px
---

## Brand & Style
The design system is engineered for a high-performance financial operating system, targeting users who demand precision, speed, and a forward-looking aesthetic. The brand personality is "Technological Elegance"—it feels like a mission control center for personal wealth. 

The style is a hybrid of **Glassmorphism** and **High-Tech Minimalism**. It utilizes deep dark surfaces to establish a sense of infinite depth, punctuated by concentrated accents of electric blue and burnt orange that represent data flow and strategic heat. The interface should evoke an emotional response of absolute control, security, and advanced intelligence. Transitions are snappy yet fluid, mimicking the precision of high-end hardware interfaces.

## Colors
The color palette is built on a "deep-space" foundation to allow high-fidelity accents to achieve maximum clarity. 
- **Primary (Electric Blue):** Reserved for core growth, active trends, and primary "success" actions.
- **Secondary (Steel Blue):** Used for information architecture, selection states, and system-level feedback.
- **Tertiary (Burnt Orange):** Signifies alerts, critical market shifts, and high-value highlights.
- **Neutral/Surface:** The background uses a balanced slate-black (#0d1117) to maintain legibility while supporting glass effects.

The system utilizes a **dark** mode default to reduce eye strain during long-term data monitoring, with surfaces layered to create a sense of structural hierarchy.

## Typography
The typography strategy prioritizes data legibility and structural hierarchy. 
- **Inter** handles all core UI elements and prose, providing a neutral, highly readable foundation.
- **Space Grotesk** is used for labels and system metadata, adding a subtle "tech-utility" character to the interface.
- **JetBrains Mono** is utilized strictly for numerical data, transaction IDs, and ticker symbols. This reinforces the "high-tech" feel and ensures that columns of numbers align perfectly for easy comparison.
- Use **Large Display** sizes for account balances with tight letter spacing to create a sense of solidity. 
- **Labels** should often be uppercase with increased tracking to serve as clear section headers.

## Layout & Spacing
The design system utilizes a **12-column fluid grid** for main dashboard views, allowing modules to stack or expand based on screen real estate. The spacing rhythm is based on a **4px base unit**.

Layouts should favor high-density information architecture but maintain "breathing room" through large outer margins (32px). Gutters are kept tight (20px) to ensure that related financial widgets feel connected. Use generous internal padding within cards (24px) to prevent data points from feeling cramped.

## Elevation & Depth
Depth is created through **Glassmorphism** and **Layered Luminescence**. 
- **Level 0 (Background):** Solid deep-tone surface.
- **Level 1 (Cards/Modules):** Background blur (20px) with a semi-transparent fill and a subtle 1px border of `rgba(8, 114, 255, 0.15)`.
- **Level 2 (Modals/Popovers):** Higher opacity fills and a soft glow using a drop shadow with the primary color (Electric Blue) at 10-15% opacity and a high blur radius (30px+).

Avoid traditional black shadows. Depth should be perceived via contrast in blur intensity and border luminance.

## Shapes
The shape language is "Squircle-Modern." A standard **8px border-radius** (rounded-md) is applied to all primary containers and buttons. This creates a balance between the aggressive "tech" nature of the colors and a more approachable, modern OS feel. 

Smaller elements like tags or checkboxes should use a **4px radius** to feel precise, while major container groups (like the main sidebar vs. content area) should use the **rounded-xl (24px)** setting to define clear macro-areas.

## Components
- **Buttons:** Primary buttons use a solid Electric Blue fill with high-contrast text. Secondary buttons use a ghost style with the Steel Blue border. All buttons have a subtle outer glow on hover.
- **Inputs:** Fields are dark with a 1px border. Upon focus, the border transitions to Electric Blue with a soft "glow" stroke.
- **Cards:** Utilize the glassmorphic style. Headers within cards should have a subtle bottom border to separate titles from content.
- **Charts:** Line graphs should use gradients (Electric Blue to transparent) for the area fill. Data points should have a "pulsing" glow animation.
- **Chips/Status:** Rounded-pill shapes. "Active" uses Electric Blue text with a 10% opacity background. "Urgent" uses Burnt Orange.
- **Data Tables:** Row hover states should use a subtle secondary tint to guide the eye without breaking the dark aesthetic.