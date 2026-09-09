import type { SVGProps } from 'react';

/**
 * Inline stroke icons — no icon dependency, no runtime cost, and they inherit
 * `currentColor` so every surface controls its own tone. Purely decorative:
 * each is `aria-hidden`, the accessible name lives on the parent control.
 */

export type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 18, children, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export const IconDashboard = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="3" width="7.5" height="8.5" rx="1.6" />
    <rect x="13.5" y="3" width="7.5" height="5.5" rx="1.6" />
    <rect x="13.5" y="11.5" width="7.5" height="9.5" rx="1.6" />
    <rect x="3" y="14.5" width="7.5" height="6.5" rx="1.6" />
  </Icon>
);

export const IconInbox = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20.5 12.5c0 3.9-3.6 7-8 7-1 0-2-.16-2.9-.46L4.5 20.5l1.2-3.4A6.6 6.6 0 0 1 4.5 12.5c0-3.9 3.6-7 8-7s8 3.1 8 7Z" />
    <path d="M9.5 11.5h6M9.5 14.5h3.5" />
  </Icon>
);

export const IconCrm = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="4" width="5" height="16" rx="1.6" />
    <rect x="9.5" y="4" width="5" height="11" rx="1.6" />
    <rect x="16" y="4" width="5" height="14" rx="1.6" />
  </Icon>
);

export const IconLeads = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="9.5" cy="8" r="3.2" />
    <path d="M3.5 19.5c0-3.1 2.7-5.2 6-5.2s6 2.1 6 5.2" />
    <path d="M16.2 5.4a3.2 3.2 0 0 1 0 6.1M18 14.7c2 .7 3.4 2.4 3.4 4.8" />
  </Icon>
);

export const IconAgenda = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3.5" y="5" width="17" height="15.5" rx="2.2" />
    <path d="M3.5 9.8h17M8.3 3.5v3M15.7 3.5v3" />
    <path d="M7.6 13.6h2.2M7.6 16.8h2.2M14.2 13.6h2.2" />
  </Icon>
);

export const IconKnowledge = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 5.2A2.2 2.2 0 0 1 6.2 3H19v14.6H6.2A2.2 2.2 0 0 0 4 19.8V5.2Z" />
    <path d="M4 19.8A2.2 2.2 0 0 0 6.2 22H19v-4.4" />
    <path d="M8.4 7.6h6.4M8.4 11h4.2" />
  </Icon>
);

export const IconFollowups = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12.6" r="7.6" />
    <path d="M12 8.6v4.2l2.7 1.7M8.6 3.4 5.2 5.6M15.4 3.4l3.4 2.2" />
  </Icon>
);

export const IconTeam = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8.4" cy="8.6" r="3" />
    <circle cx="16.4" cy="9.6" r="2.4" />
    <path d="M3 19.2c0-2.9 2.4-4.8 5.4-4.8s5.4 1.9 5.4 4.8" />
    <path d="M15.4 14.7c2.9-.3 5.6 1.2 5.6 4.5" />
  </Icon>
);

export const IconSettings = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 14.4a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.56-1.1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1.03Z" />
  </Icon>
);

export const IconSearch = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="6.6" />
    <path d="m16 16 4.5 4.5" />
  </Icon>
);

export const IconBell = (p: IconProps) => (
  <Icon {...p}>
    <path d="M18 8.6a6 6 0 1 0-12 0c0 5-2 6.4-2 6.4h16s-2-1.4-2-6.4Z" />
    <path d="M13.7 19a2 2 0 0 1-3.4 0" />
  </Icon>
);

export const IconLogout = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9.5 20.5H6a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2h3.5" />
    <path d="M15.5 16.5 20 12l-4.5-4.5M20 12H9.5" />
  </Icon>
);

export const IconMenu = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Icon>
);

export const IconClose = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
);

export const IconChevronDown = (p: IconProps) => (
  <Icon {...p}>
    <path d="m6 9.5 6 6 6-6" />
  </Icon>
);

export const IconChevronRight = (p: IconProps) => (
  <Icon {...p}>
    <path d="m9.5 6 6 6-6 6" />
  </Icon>
);

export const IconPlus = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const IconFilter = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 6h16l-6.2 7.3v5.4l-3.6 1.8v-7.2Z" />
  </Icon>
);

export const IconSparkles = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3.5 13.7 8l4.5 1.7-4.5 1.7L12 16l-1.7-4.6L5.8 9.7 10.3 8Z" />
    <path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8Z" />
  </Icon>
);

export const IconUser = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="8.4" r="3.4" />
    <path d="M4.8 20c0-3.5 3.2-5.8 7.2-5.8s7.2 2.3 7.2 5.8" />
  </Icon>
);

export const IconClock = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.2" />
    <path d="M12 7.4V12l3 1.8" />
  </Icon>
);

export const IconCheck = (p: IconProps) => (
  <Icon {...p}>
    <path d="m5 12.8 4.5 4.4L19 7.6" />
  </Icon>
);

export const IconShield = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3.2 19 6v6c0 4.3-2.9 7.5-7 8.8-4.1-1.3-7-4.5-7-8.8V6Z" />
    <path d="m9.2 12.2 2 2 3.6-3.8" />
  </Icon>
);

export const IconPlug = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9 3.5v5M15 3.5v5" />
    <path d="M6.4 8.5h11.2v3.1a5.6 5.6 0 0 1-11.2 0Z" />
    <path d="M12 17.2v3.3" />
  </Icon>
);

export const IconBuilding = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4.5 20.5V5.2a1.7 1.7 0 0 1 1.7-1.7h7.1a1.7 1.7 0 0 1 1.7 1.7v15.3" />
    <path d="M15 10.4h2.9a1.7 1.7 0 0 1 1.7 1.7v8.4M3 20.5h18" />
    <path d="M8 7.6h3.4M8 11.4h3.4M8 15.2h3.4" />
  </Icon>
);

export const IconDocument = (p: IconProps) => (
  <Icon {...p}>
    <path d="M13.6 3.5H7.2a1.8 1.8 0 0 0-1.8 1.8v13.4a1.8 1.8 0 0 0 1.8 1.8h9.6a1.8 1.8 0 0 0 1.8-1.8V8.4Z" />
    <path d="M13.4 3.6v4.9h5.1M8.6 13h6.8M8.6 16.4h4.4" />
  </Icon>
);

export const IconHelp = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.4" />
    <path d="M9.6 9.6a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .9-1 1.7M12 16.6h.01" />
  </Icon>
);

export const IconWhatsapp = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20 11.8a8 8 0 0 1-11.9 7L4 20.2l1.4-4a8 8 0 1 1 14.6-4.4Z" />
    <path d="M9.3 9.1c.3-.6.6-.6.9-.6h.6c.2 0 .4.2.5.5l.5 1.2c0 .2 0 .4-.2.6l-.4.4c-.1.2-.2.4 0 .6a5 5 0 0 0 2.2 2c.2.1.4 0 .6-.1l.5-.6c.1-.2.3-.2.5-.1l1.3.6c.2.1.3.3.3.5 0 .7-.5 1.3-1.2 1.5-1.5.4-4-.9-5.4-3-.8-1.2-1.1-2.6-.7-3.5Z" />
  </Icon>
);

export const IconTrend = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 16.5 9 11l3.4 3.4L20.5 6" />
    <path d="M15.6 6h4.9v4.9" />
  </Icon>
);

export const IconTarget = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.2" />
    <circle cx="12" cy="12" r="4.4" />
    <circle cx="12" cy="12" r="1" />
  </Icon>
);

export const IconMessage = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20.5 12c0 4.1-3.8 7.4-8.5 7.4a9.8 9.8 0 0 1-3-.46L4.5 20.5l1.2-3.6A6.9 6.9 0 0 1 3.5 12c0-4.1 3.8-7.4 8.5-7.4S20.5 7.9 20.5 12Z" />
  </Icon>
);

export const IconVideo = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="6" width="12.5" height="12" rx="2.4" />
    <path d="M15.5 10.2 21 7.4v9.2l-5.5-2.8Z" />
  </Icon>
);

export const IconArrowRight = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4.5 12h15M13.5 6l6 6-6 6" />
  </Icon>
);

/**
 * Brand mark for Inovasix6 Comercial IA — an upward "N/growth" glyph evoking
 * commercial acceleration. Uses currentColor so the container controls the fill;
 * placed on the brand gradient surface it reads as the product logo.
 */
export const IconLogo = ({ size = 20, ...props }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2.1}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
    {...props}
  >
    <path d="M5 18V6.5L19 18V6" />
  </svg>
);
