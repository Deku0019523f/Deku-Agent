import chalk from "chalk";

/** Emblème ASCII original (losange stylisé), dans le même esprit visuel que les TUI d'agents modernes. */
const LOGO = [
  "      @@@@@@      ",
  "    @@@@@@@@@@    ",
  "   @@@@@@@@@@@@   ",
  "  @@@@  @@  @@@@  ",
  " @@@@    @    @@@@ ",
  "  @@@@  @@  @@@@  ",
  "   @@@@@@@@@@@@   ",
  "    @@@@@@@@@@    ",
  "      @@@@@@      ",
];

export function printSplash(cwd: string): void {
  console.log();
  for (const line of LOGO) console.log(chalk.cyan(line));
  console.log();
  console.log(chalk.bold("Que puis-je faire pour toi ?"));
  console.log(chalk.dim(`Dossier : ${cwd}`));
  console.log(chalk.dim("Tape / pour les commandes (essaie /help), Ctrl+C pour quitter."));
  console.log();
}
