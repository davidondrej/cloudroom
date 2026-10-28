function quoteResourceName(name: string): string {
  return JSON.stringify(name);
}

export function buildPluginEditThreadPrompt({
  name,
  path,
}: {
  name: string;
  path: string;
}): string {
  return `Edit the Cloudroom plugin ${quoteResourceName(name)} at ${path}. I want to `;
}

export function buildSkillEditThreadPrompt({
  id,
  name,
  path,
}: {
  id: string;
  name: string;
  path: string;
}): string {
  return `Edit the Cloudroom skill ${quoteResourceName(name)} (ID ${id}) at ${path}. Inspect it with room-cli skill show ${id} --json and pass that revision to room-cli skill update when saving. I want to `;
}

export function buildAutomationEditThreadPrompt({
  name,
  projectId,
  automationId,
}: {
  name: string;
  projectId: string;
  automationId: string;
}): string {
  return `Edit the Cloudroom loop ${quoteResourceName(name)} (ID ${automationId}) in project ${projectId}. I want to `;
}
