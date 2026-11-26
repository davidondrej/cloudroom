import { templateDefinitions, type TemplateId } from "@cloudroom/templates/generated";

export interface GuideRenderArgs {
  chapter?: string;
}

export interface GuideRenderResult {
  chapter?: string;
  content: string;
}

export interface GuideArea {
  render(args?: GuideRenderArgs): GuideRenderResult;
}

const guideChapters: Record<string, TemplateId> = {
  threads: "roomGuideThreads",
  environments: "roomGuideEnvironments",
  "agent-configuration": "roomGuideAgentConfiguration",
  providers: "roomGuideProviders",
  projects: "roomGuideProjects",
  machines: "roomGuideMachines",
  terminals: "roomGuideTerminals",
  browser: "roomGuideBrowser",
  customization: "roomGuideCustomization",
  plugins: "roomGuidePlugins",
  automations: "roomGuideAutomations",
};

const templateBodyById = new Map(
  templateDefinitions.map((template) => [template.id, template.body]),
);

function renderStaticTemplate(templateId: TemplateId): string {
  const body = templateBodyById.get(templateId);
  if (body === undefined) {
    throw new Error(`Template '${templateId}' is unavailable.`);
  }
  return body;
}

export function createGuideArea(): GuideArea {
  return {
    render(input = {}) {
      if (!input.chapter) {
        return { content: renderStaticTemplate("roomGuideOverview") };
      }
      const templateId = guideChapters[input.chapter];
      if (!templateId) {
        const available = Object.keys(guideChapters).join(", ");
        throw new Error(
          `Unknown guide chapter '${input.chapter}'. Available: ${available}.`,
        );
      }
      return {
        chapter: input.chapter,
        content: renderStaticTemplate(templateId),
      };
    },
  };
}
