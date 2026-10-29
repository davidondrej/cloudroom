export const defaultThemeCss = `
:root, .light {
  --border: color-mix(in oklab, var(--primary) 35%, var(--canvas));
  --border-hairline: color-mix(in oklab, var(--primary) 38%, var(--canvas));
  --border-seam: color-mix(in oklab, var(--primary) 30%, var(--canvas));
  --sidebar-border: color-mix(in oklab, var(--primary) 35%, var(--canvas));
  --input: color-mix(in oklab, var(--primary) 80%, var(--canvas));
  --timeline-accent: var(--primary);
  --file-accent: var(--timeline-accent);
}
.dark {
  --border: color-mix(in oklab, var(--primary) 34%, var(--canvas));
  --border-hairline: color-mix(in oklab, var(--primary) 36%, var(--canvas));
  --border-seam: color-mix(in oklab, var(--primary) 40%, var(--canvas));
  --sidebar-border: color-mix(in oklab, var(--primary) 34%, var(--canvas));
  --input: color-mix(in oklab, var(--primary) 60%, var(--canvas));
  --timeline-accent: var(--primary);
  --file-accent: var(--timeline-accent);
}
:root:not(.dark), .light {
  --primary: #457500;
  --primary-foreground: #ffffff;
  --primary-text: #3d5600;
  --ring: var(--primary);
  --sidebar-ring: var(--ring);
  --skill-mention-foreground: var(--primary);
}
`;
