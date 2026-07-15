import type { ReactElement, SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;
const S = (props: P & { children: ReactElement | ReactElement[] }) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" {...props}>
    {props.children}
  </svg>
);

export const LogoIcon = (props: P) => (
  <svg viewBox="0 0 32 32" {...props}>
    <rect x="2" y="2" width="28" height="28" rx="6" fill="#0f4c3a" />
    <rect x="7" y="10" width="12" height="12" rx="2" fill="#10151b" stroke="#c9a227" strokeWidth="1" />
    <g stroke="#c9a227" strokeWidth="1.6" strokeLinecap="round">
      <line x1="9.5" y1="10" x2="9.5" y2="6" /><line x1="13" y1="10" x2="13" y2="6" /><line x1="16.5" y1="10" x2="16.5" y2="6" />
      <line x1="9.5" y1="22" x2="9.5" y2="26" /><line x1="13" y1="22" x2="13" y2="26" /><line x1="16.5" y1="22" x2="16.5" y2="26" />
      <line x1="19" y1="13" x2="24" y2="13" /><line x1="19" y1="16" x2="26" y2="16" /><line x1="19" y1="19" x2="24" y2="19" />
    </g>
    <circle cx="26" cy="16" r="2" fill="#e8555a" />
  </svg>
);

export const CursorIcon = (props: P) => <S {...props}><path d="M4 2l8 7-4 .7L10 14l-2 .8-2-4.3L3 12z" fill="currentColor" stroke="none" /></S>;
export const WireIcon = (props: P) => <S {...props}><circle cx="3.5" cy="12.5" r="1.8" /><circle cx="12.5" cy="3.5" r="1.8" /><path d="M5 11.5C7 9 9 7.5 11 5" /></S>;
export const PanIcon = (props: P) => <S {...props}><path d="M8 1.5v13M1.5 8h13M8 1.5L6 3.5M8 1.5l2 2M8 14.5l-2-2M8 14.5l2-2M1.5 8l2-2M1.5 8l2 2M14.5 8l-2-2M14.5 8l-2 2" /></S>;
export const UndoIcon = (props: P) => <S {...props}><path d="M3 6h7a3.5 3.5 0 0 1 0 7H6" /><path d="M5.5 3.5L3 6l2.5 2.5" /></S>;
export const RedoIcon = (props: P) => <S {...props}><path d="M13 6H6a3.5 3.5 0 0 0 0 7h4" /><path d="M10.5 3.5L13 6l-2.5 2.5" /></S>;
export const TrashIcon = (props: P) => <S {...props}><path d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9.5h6.6L12 4M6.5 6.8v4M9.5 6.8v4" /></S>;
export const RotateIcon = (props: P) => <S {...props}><path d="M13 8a5 5 0 1 1-1.8-3.8" /><path d="M13 1.8V4.5h-2.7" /></S>;
export const ZoomInIcon = (props: P) => <S {...props}><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14M7 5v4M5 7h4" /></S>;
export const ZoomOutIcon = (props: P) => <S {...props}><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14M5 7h4" /></S>;
export const FitIcon = (props: P) => <S {...props}><path d="M2 5.5V2h3.5M14 5.5V2h-3.5M2 10.5V14h3.5M14 10.5V14h-3.5" /><rect x="5.5" y="5.5" width="5" height="5" rx="1" /></S>;
export const CheckShieldIcon = (props: P) => <S {...props}><path d="M8 1.5l5.5 2v4c0 3.5-2.4 5.9-5.5 7-3.1-1.1-5.5-3.5-5.5-7v-4z" /><path d="M5.5 8l1.8 1.8L10.8 6" /></S>;
export const HammerIcon = (props: P) => <S {...props}><path d="M9.2 5.4l-6.7 6.7 1.4 1.4 6.7-6.7" /><path d="M8 2.5l2-1 3.5 3.5.5 2.5-2 .5L8 4z" fill="currentColor" stroke="none" /></S>;
export const PlayIcon = (props: P) => <S {...props}><path d="M4.5 2.8v10.4L13 8z" fill="currentColor" stroke="none" /></S>;
export const PauseIcon = (props: P) => <S {...props}><rect x="3.5" y="2.8" width="3.2" height="10.4" rx="0.8" fill="currentColor" stroke="none" /><rect x="9.3" y="2.8" width="3.2" height="10.4" rx="0.8" fill="currentColor" stroke="none" /></S>;
export const StepIcon = (props: P) => <S {...props}><path d="M3 2.8v10.4L9.5 8z" fill="currentColor" stroke="none" /><rect x="11" y="2.8" width="2.4" height="10.4" rx="0.8" fill="currentColor" stroke="none" /></S>;
export const ResetIcon = (props: P) => <S {...props}><path d="M3 8a5 5 0 1 0 1.5-3.6" /><path d="M3 2v3h3" /></S>;
export const StopIcon = (props: P) => <S {...props}><rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="currentColor" stroke="none" /></S>;
export const ExportIcon = (props: P) => <S {...props}><path d="M8 10V2M8 2L5.2 4.8M8 2l2.8 2.8M2.5 9.5v3a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3" /></S>;
export const BackIcon = (props: P) => <S {...props}><path d="M10 2.5L4.5 8 10 13.5" /></S>;
export const PlusIcon = (props: P) => <S {...props}><path d="M8 3v10M3 8h10" /></S>;
export const ImportIcon = (props: P) => <S {...props}><path d="M8 2v8M8 10l-2.8-2.8M8 10l2.8-2.8M2.5 9.5v3a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3" /></S>;
export const SearchIcon = (props: P) => <S {...props}><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></S>;
export const DotsIcon = (props: P) => <S {...props}><circle cx="3" cy="8" r="1.3" fill="currentColor" stroke="none" /><circle cx="8" cy="8" r="1.3" fill="currentColor" stroke="none" /><circle cx="13" cy="8" r="1.3" fill="currentColor" stroke="none" /></S>;
export const WarnIcon = (props: P) => <S {...props}><path d="M8 2L15 13.5H1z" /><path d="M8 6.5v3.2M8 11.8v.2" /></S>;
export const ErrorIcon = (props: P) => <S {...props}><circle cx="8" cy="8" r="6.3" /><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" /></S>;
export const InfoIcon = (props: P) => <S {...props}><circle cx="8" cy="8" r="6.3" /><path d="M8 7.2v4M8 4.8v.2" /></S>;
export const CheckIcon = (props: P) => <S {...props}><path d="M2.5 8.5l3.5 3.5 7.5-8" /></S>;
export const ChipIcon = (props: P) => <S {...props}><rect x="4" y="4" width="8" height="8" rx="1" /><path d="M6 4V2M8 4V2M10 4V2M6 14v-2M8 14v-2M10 14v-2M4 6H2M4 8H2M4 10H2M14 6h-2M14 8h-2M14 10h-2" /></S>;
export const CollapseLeftIcon = (props: P) => <S {...props}><path d="M9.5 3L5 8l4.5 5M12 3v10" /></S>;
export const CollapseRightIcon = (props: P) => <S {...props}><path d="M6.5 3L11 8l-4.5 5M4 3v10" /></S>;
export const FlaskIcon = (props: P) => <S {...props}><path d="M6 2h4M6.8 2v4L3 12.5A1.4 1.4 0 0 0 4.2 14.5h7.6a1.4 1.4 0 0 0 1.2-2L9.2 6V2" /><path d="M5 10h6" /></S>;
