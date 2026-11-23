import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerShortcut("alt+shift+t", {
    description: "Cycle thinking level backwards",
    handler: async (ctx) => {
      const levels = ctx.model ? getSupportedThinkingLevels(ctx.model) : [];
      if (levels.length < 2) {
        ctx.ui.notify("Current model does not support thinking");
        return;
      }
      const index = levels.indexOf(pi.getThinkingLevel());
      const prev = levels[(index <= 0 ? levels.length : index) - 1];
      pi.setThinkingLevel(prev);
      ctx.ui.notify(`Thinking level: ${prev}`);
    },
  });
}
