import chalk from "chalk";

export interface SelectItem {
  label: string;
  value: string;
  hint?: string;
}

export interface SelectOptions {
  title: string;
  subtitle?: string;
  items: SelectItem[];
  searchPlaceholder?: string;
  /** Libellé de l'entrée "saisie manuelle" ajoutée en bas de liste, si fourni. */
  customEntryLabel?: string;
}

export type SelectResult =
  | { kind: "value"; value: string }
  | { kind: "custom" } // l'utilisateur a choisi l'entrée "saisie manuelle"
  | { kind: "cancel" };

const ABSOLUTE_MAX_VISIBLE = 15;
const MIN_VISIBLE = 3;
const ESC_TIMEOUT_MS = 40;

/** Retire les codes couleur ANSI pour mesurer la largeur RÉELLE affichée d'une ligne. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Nombre de lignes TERMINAL (physiques) qu'occupe une ligne logique, vu le wrap. */
function rowsForLine(line: string, columns: number): number {
  const width = stripAnsi(line).length;
  return Math.max(1, Math.ceil(width / Math.max(1, columns)));
}

function totalRows(lines: string[], columns: number): number {
  return lines.reduce((sum, line) => sum + rowsForLine(line, columns), 0);
}

/**
 * Menu déroulant avec recherche live et navigation flèches, rendu en place
 * (redessine sur lui-même via des codes ANSI, sans écran alternatif — reste
 * lisible même sur un terminal Termux minimal). Nécessite un vrai TTY ;
 * hors TTY (pipe, script), retombe sur une sélection en clair par numéro.
 */
export function selectMenu(options: SelectOptions): Promise<SelectResult> {
  if (!process.stdin.isTTY) return selectMenuFallback(options);

  return new Promise((resolve) => {
    const { title, subtitle, items, searchPlaceholder, customEntryLabel } = options;
    let query = "";
    let selectedIndex = 0;
    let previousLineCount = 0;
    let escTimer: ReturnType<typeof setTimeout> | null = null;
    let buf = "";

    function allEntries(): SelectItem[] {
      return customEntryLabel ? [...items, { label: customEntryLabel, value: "__custom__" }] : items;
    }

    function filtered(): SelectItem[] {
      const q = query.trim().toLowerCase();
      const entries = allEntries();
      if (!q) return entries;
      // L'entrée "saisie manuelle" reste toujours visible même filtrée.
      return entries.filter(
        (item) => item.value === "__custom__" || item.label.toLowerCase().includes(q)
      );
    }

    function render() {
      const columns = process.stdout.columns || 80;
      const rows = process.stdout.rows || 24;
      const matches = filtered();

      // Lignes fixes (en-tête + pied de page), mesurées AVANT de savoir
      // combien d'items on peut se permettre d'afficher.
      const headerLines: string[] = [];
      headerLines.push(chalk.bold(title));
      if (subtitle) headerLines.push(chalk.dim(subtitle));
      headerLines.push("");
      headerLines.push(chalk.dim(`${searchPlaceholder ?? "Rechercher..."} `) + query + chalk.dim("_"));
      headerLines.push("");
      const footerLines: string[] = ["", chalk.dim("↑/↓ naviguer · Entrée valider · Échap annuler")];

      const fixedRows = totalRows(headerLines, columns) + totalRows(footerLines, columns);
      // +1 de marge de sécurité pour ne jamais coller pile au bord de l'écran.
      const maxVisible = Math.max(MIN_VISIBLE, Math.min(ABSOLUTE_MAX_VISIBLE, rows - fixedRows - 1));

      selectedIndex = Math.max(0, Math.min(selectedIndex, matches.length - 1));
      const visible = matches.slice(0, maxVisible);

      const itemLines: string[] = [];
      if (visible.length === 0) {
        itemLines.push(chalk.dim("  (aucun résultat)"));
      } else {
        visible.forEach((item, i) => {
          if (i === selectedIndex) {
            itemLines.push(chalk.bgCyan.black(` ❯ ${item.label} `) + (item.hint ? chalk.dim(` ${item.hint}`) : ""));
          } else {
            itemLines.push(`   ${item.label}` + (item.hint ? chalk.dim(` ${item.hint}`) : ""));
          }
        });
      }
      if (matches.length > visible.length) {
        itemLines.push(chalk.dim(`   … ${matches.length - visible.length} de plus (affine la recherche)`));
      }

      const lines = [...headerLines, ...itemLines, ...footerLines];

      // Efface intégralement le bloc précédent (en lignes PHYSIQUES, pas
      // logiques) avant de redessiner — indispensable dès qu'une ligne
      // dépasse la largeur du terminal et wrap sur plusieurs rangées
      // (cas courant sur écran de téléphone étroit), sinon le curseur
      // remonte au mauvais endroit et les anciens rendus s'empilent au
      // lieu d'être remplacés.
      if (previousLineCount > 0) {
        process.stdout.write(`\x1b[${previousLineCount}A\r`);
        for (let i = 0; i < previousLineCount; i++) {
          process.stdout.write("\x1b[2K");
          // \r\n explicite : on ne dépend jamais de la traduction terminal
          // \n -> \r\n (onlcr), qui peut varier selon l'émulateur/clavier
          // étendu utilisé (cf. clavier Termux custom vu en capture).
          if (i < previousLineCount - 1) process.stdout.write("\r\n");
        }
        if (previousLineCount > 1) process.stdout.write(`\x1b[${previousLineCount - 1}A`);
        process.stdout.write("\r");
      }

      for (const line of lines) {
        process.stdout.write(`${line}\r\n`);
      }
      previousLineCount = totalRows(lines, columns);
    }

    function confirmSelection() {
      const matches = filtered();
      const chosen = matches[selectedIndex];
      cleanup();
      if (!chosen) return resolve({ kind: "cancel" });
      if (chosen.value === "__custom__") return resolve({ kind: "custom" });
      resolve({ kind: "value", value: chosen.value });
    }

    function cancel() {
      cleanup();
      resolve({ kind: "cancel" });
    }

    function cleanup() {
      if (escTimer) clearTimeout(escTimer);
      stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
      stdin.removeListener("data", onData);
    }

    function processToken(token: string) {
      if (token === "\x1b[A" || token === "\x10") {
        // Flèche haut / Ctrl+P
        selectedIndex = Math.max(0, selectedIndex - 1);
        render();
      } else if (token === "\x1b[B" || token === "\x0e") {
        // Flèche bas / Ctrl+N
        const max = Math.max(0, filtered().length - 1);
        selectedIndex = Math.min(max, selectedIndex + 1);
        render();
      } else if (token === "\r" || token === "\n") {
        confirmSelection();
      } else if (token === "\x1b") {
        cancel();
      } else if (token === "\x03") {
        cleanup();
        process.exit(130);
      } else if (token === "\u007f" || token === "\b") {
        if (query.length > 0) {
          query = query.slice(0, -1);
          selectedIndex = 0;
          render();
        }
      } else if (token.length === 1 && token >= " ") {
        query += token;
        selectedIndex = 0;
        render();
      }
      // séquences ANSI non gérées (PgUp/Home/...) : ignorées silencieusement
    }

    function onData(chunk: string) {
      buf += chunk.toString();
      while (buf.length > 0) {
        if (buf.startsWith("\x1b[A") || buf.startsWith("\x1b[B")) {
          const token = buf.slice(0, 3);
          buf = buf.slice(3);
          processToken(token);
          continue;
        }
        if (buf === "\x1b") {
          // Ambigu: début d'une séquence pas encore complète, ou vrai Échap
          // seul. On attend un court instant pour voir si la suite arrive.
          if (escTimer) clearTimeout(escTimer);
          escTimer = setTimeout(() => {
            if (buf === "\x1b") {
              buf = "";
              processToken("\x1b");
            }
          }, ESC_TIMEOUT_MS);
          break;
        }
        if (buf.startsWith("\x1b")) {
          // Autre séquence ANSI (Home/End/PgUp/PgDn/flèches gauche-droite du
          // clavier étendu Termux) : consommée en bloc, ignorée.
          const match = buf.match(/^\x1b\[[0-9;]*[A-Za-z~]/);
          if (match) {
            buf = buf.slice(match[0].length);
            continue;
          }
          break; // séquence incomplète, attend la suite du chunk
        }
        const c = buf[0];
        buf = buf.slice(1);
        processToken(c);
      }
    }

    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", onData);

    render();
  });
}

/** Repli non-TTY : liste numérotée classique, une seule ligne de saisie. */
async function selectMenuFallback(options: SelectOptions): Promise<SelectResult> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log(options.title);
  const entries = options.customEntryLabel
    ? [...options.items, { label: options.customEntryLabel, value: "__custom__" }]
    : options.items;
  entries.forEach((item, i) => console.log(`  ${i + 1}. ${item.label}`));

  const answer = (await rl.question("> ")).trim();
  rl.close();
  const index = parseInt(answer, 10) - 1;
  if (index < 0 || index >= entries.length) return { kind: "cancel" };
  if (entries[index].value === "__custom__") return { kind: "custom" };
  return { kind: "value", value: entries[index].value };
}
