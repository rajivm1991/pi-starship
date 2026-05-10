/**
 * Starship + pi footer extension
 *
 * Left side  — delegates entirely to `starship prompt` so colours, icons, and
 *              segments match your shell exactly. Appends PR #N (clickable) if
 *              there is an open PR for the current branch.
 *
 * Right side — anthropic → Claude Haiku 4.5 ◆ medium  ↑12k ↓4k $0.042
 *
 * Prerequisites: starship and gh must be in PATH.
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ── Colour helpers (right side only) ────────────────────────────────────────

const bold    = (s: string) => `\x1b[1m${s}\x1b[22m`;
const dim     = (s: string) => `\x1b[2m${s}\x1b[22m`;
const magenta = (s: string) => `\x1b[95m${s}\x1b[39m`;
const cyan    = (s: string) => `\x1b[96m${s}\x1b[39m`;
const green   = (s: string) => `\x1b[92m${s}\x1b[39m`;
const yellow  = (s: string) => `\x1b[93m${s}\x1b[39m`;

function hyperlink(url: string, text: string): string {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

// ── Data fetching ────────────────────────────────────────────────────────────

interface PRInfo { number: number; url: string; }

async function fetchStarshipPrompt(cwd: string, width: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "starship",
      [
        "prompt",
        `--terminal-width=${width}`,
        "--status=0",
        "--keymap=",
        "--pipestatus=0",
        "--cmd-duration=0",
        "--jobs=0",
      ],
      // Pass PWD so starship picks up the correct directory context
      { cwd, timeout: 3000, env: { ...process.env, PWD: cwd, STARSHIP_SHELL: "bash" } },
    );
    // Skip leading blank lines (some configs use add_newline = true) and take the
    // first non-empty line — that's the info line. The trailing prompt char line
    // (❯ / ╰─┼) is naturally dropped.
    const firstLine = stdout.split("\n").find((l) => l.trim().length > 0) ?? "";
    // bash format: \[ and \] are non-printing markers; ESC is already present
    //   inside them, so just strip the markers.
    // zsh format:  %{ and %} wrap content WITHOUT ESC; add ESC when stripping.
    const ansi = firstLine
      .replace(/\\\[/g, "")         // bash: remove \[ (ESC already inside)
      .replace(/\\\]/g, "")         // bash: remove \]
      .replace(/%\{/g,  "\x1b")     // zsh:  %{ → ESC
      .replace(/%\}/g,  "");         // zsh:  remove %}
    // Strip trailing ANSI reset codes first (starship appends them after the
    // last segment's trailing space), then trim the remaining whitespace.
    const clean = ansi
      .replace(/(\x1b\[[0-9;]*m)+$/g, "")
      .trimEnd();
    return clean || null;
  } catch { return null; }
}

async function fetchPR(cwd: string): Promise<PRInfo | null> {
  try {
    const { stdout } = await execFileAsync(
      "gh", ["pr", "view", "--json", "number,url"],
      { cwd, timeout: 5000 },
    );
    const { number, url } = JSON.parse(stdout.trim());
    return (number && url) ? { number, url } : null;
  } catch { return null; }
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let starshipPrompt: string | null = null;
  let pr: PRInfo | null             = null;
  let thinkingLevel: string         = "off";
  let lastRenderWidth               = 120;
  let requestRender: (() => void) | undefined;

  async function refreshStarship(cwd: string, width: number) {
    starshipPrompt = await fetchStarshipPrompt(cwd, width);
    requestRender?.();
  }

  async function refreshAll(cwd: string) {
    [pr] = await Promise.all([
      fetchPR(cwd),
      refreshStarship(cwd, lastRenderWidth),
    ]);
    requestRender?.();
  }

  pi.on("session_start", async (_event, ctx) => {
    thinkingLevel = pi.getThinkingLevel();
    refreshAll(ctx.cwd);

    ctx.ui.setFooter((tui, _theme, footerData) => {
      requestRender = () => tui.requestRender();

      const unsub = footerData.onBranchChange(() => refreshAll(ctx.cwd));

      return {
        dispose: unsub,
        invalidate() {},
        render(width: number): string[] {
          // Re-fetch starship if the terminal was resized
          if (width !== lastRenderWidth) {
            lastRenderWidth = width;
            refreshStarship(ctx.cwd, width);
          }

          // ── Left: starship output + PR ───────────────────────────────────
          const leftParts: string[] = [];

          if (starshipPrompt) leftParts.push(starshipPrompt);

          if (pr) {
            leftParts.push(" " + hyperlink(pr.url, bold(cyan(`PR #${pr.number}`))));
          }

          const left = leftParts.join("");

          // ── Right: model ◆ thinking  ↑in ↓out $cost ────────────────────
          const rightParts: string[] = [];

          if (ctx.model) {
            rightParts.push(dim(ctx.model.provider + " → ") + bold(magenta(ctx.model.name)));
          }

          if (thinkingLevel !== "off") {
            rightParts.push(" " + dim("◆ ") + cyan(thinkingLevel));
          }

          let inputTok = 0, outputTok = 0, totalCost = 0;
          for (const e of ctx.sessionManager.getBranch()) {
            if (e.type === "message" && e.message.role === "assistant") {
              const m = e.message as AssistantMessage;
              inputTok  += m.usage.input;
              outputTok += m.usage.output;
              totalCost += m.usage.cost.total;
            }
          }

          if (inputTok > 0 || outputTok > 0) {
            const fmt = (n: number) => n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
            rightParts.push(
              ` ${cyan(`↑${fmt(inputTok)}`)}`,
              ` ${green(`↓${fmt(outputTok)}`)}`,
              ` ${yellow(`$${totalCost.toFixed(3)}`)}`,
            );
          }

          const right = rightParts.join("");
          const gap = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));

          return [truncateToWidth(left + gap + right, width)];
        },
      };
    });
  });

  pi.on("agent_end", (_event, ctx) => {
    refreshAll(ctx.cwd);
  });

  pi.on("thinking_level_select", async (event, _ctx) => {
    thinkingLevel = event.level;
    requestRender?.();
  });
}
