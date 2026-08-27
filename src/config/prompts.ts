import type { Interface as ReadlineInterface } from "node:readline/promises";

/** Menu numéroté simple, réutilise l'interface readline déjà ouverte. */
export async function promptSelect(
  rl: ReadlineInterface,
  question: string,
  options: { label: string; value: string }[]
): Promise<string> {
  console.log(question);
  options.forEach((opt, i) => console.log(`  ${i + 1}. ${opt.label}`));
  while (true) {
    const answer = (await rl.question("> ")).trim();
    const index = parseInt(answer, 10) - 1;
    if (index >= 0 && index < options.length) return options[index].value;
    console.log(`Entrée invalide, choisis un numéro entre 1 et ${options.length}.`);
  }
}

/**
 * Saisie masquée (affiche '*' au lieu des caractères tapés) pour les clés
 * API — via stdin en mode raw, sans dépendance externe. Nécessite un vrai
 * TTY ; si l'entrée est redirigée/pipée (pas de TTY, ex: script CI), on
 * retombe sur une saisie en clair plutôt que de bloquer indéfiniment.
 */
export function promptMasked(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;

    if (!stdin.isTTY) {
      // Pas de TTY : lecture en clair via readline classique, sur un seul usage.
      import("node:readline/promises").then(async ({ createInterface }) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await rl.question("");
        rl.close();
        resolve(answer.trim());
      });
      return;
    }

    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let input = "";
    const onData = (chunk: string) => {
      // Un event 'data' peut regrouper plusieurs caractères (collage d'une
      // clé API, terminal qui bufferise, écriture programmatique groupée)
      // — ne JAMAIS traiter tout le chunk comme une seule touche, sous
      // peine de rater un retour à la ligne noyé au milieu du paquet et de
      // bloquer le prompt indéfiniment. On traite donc caractère par
      // caractère.
      for (const c of chunk) {
        if (c === "\n" || c === "\r" || c === "\u0004") {
          cleanup();
          process.stdout.write("\n");
          resolve(input.trim());
          return;
        } else if (c === "\u0003") {
          cleanup();
          process.stdout.write("\n");
          process.exit(130); // Ctrl+C : convention shell (128 + SIGINT)
        } else if (c === "\u007f" || c === "\b") {
          if (input.length > 0) {
            input = input.slice(0, -1);
            process.stdout.write("\b \b");
          }
        } else if (c >= " ") {
          // Ignore les autres codes de contrôle (flèches, tab...), n'accepte
          // que les caractères imprimables.
          input += c;
          process.stdout.write("*");
        }
      }
    };

    function cleanup() {
      stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
      stdin.removeListener("data", onData);
    }

    stdin.on("data", onData);
  });
}
