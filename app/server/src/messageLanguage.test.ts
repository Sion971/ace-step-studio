// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';

// Everything the server sends back or throws is in English, like the rest of its code: the server does not know the language of the
// interface, so it cannot translate, and the interface shows its text as it receives it ("Aucun fichier audio recu...", "Separation
// interrompue apres 600s" were seen by every user). This fails when a French message appears in a response, in a thrown error, or in the
// "error" field of a Python script whose JSON the server forwards.
//
// Not covered, on purpose: log lines (console.*, the standard error of the scripts) are for the developer and may be in any language.
// Heuristic, like the interface test: the accent test and the word list below are not a dictionary, and a message kept in a variable
// and sent further away escapes the syntax-tree reading.

const ACCENT = /[àâäçéèêëîïôöûùüÿœ]/i;
const STRONG = /\b(ajouter|supprimer|fermer|ouvrir|annuler|valider|enregistrer|sauvegarder|chargement|charger|erreur|echec|fichier|chanson|morceau|paroles|creer|generer|telecharger|rechercher|choisir|selectionner|modifier|aucun|aucune|introuvable|interrompu|interrompue|inattendue|inattendu|requis|invalide|entrainement|lance|depuis|avant)\b/i;
const FUNC = /\b(le|la|les|des|du|un|une|pour|avec|sans|dans|sur|est|sont|pas|vous|votre|ton|tes|ou|et|au|aux|ces|cette|apres|mais)\b/gi;

export function looksFrench(text: string): boolean {
  const s = text.replace(/\$\{[^}]*\}/g, ' ');
  return ACCENT.test(s) || STRONG.test(s) || (s.match(FUNC) ?? []).length >= 2;
}

const KEYS = new Set(['error', 'message', 'detail', 'details', 'hint', 'warning', 'reason', 'title', 'description', 'statusMessage']);
const calleeName = (e: ts.Expression): string => (ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : '');

function strings(node: ts.Node | undefined): string[] {
  if (!node) return [];
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isTemplateExpression(node)) return [node.head.text + node.templateSpans.map((s) => '${…}' + s.literal.text).join('')];
  if (ts.isConditionalExpression(node)) return [...strings(node.whenTrue), ...strings(node.whenFalse)];
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return strings(node.expression);
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.PlusToken) return [...strings(node.left), ...strings(node.right)];
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return strings(node.right);
  }
  return [];
}

/** What the server can send or throw: properties like error/message, thrown errors, and send(...). Never console.*. */
export function serverMessages(source: string, fileName = 'fixture.ts'): { line: number; text: string }[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: { line: number; text: string }[] = [];
  const push = (node: ts.Node, text: string) => {
    const t = text.replace(/\s+/g, ' ').trim();
    if (t) found.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: t });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node)) {
      const key = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : '';
      if (KEYS.has(key)) strings(node.initializer).forEach((s) => push(node, s));
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && /Error$/.test(node.expression.text) && node.arguments?.length) {
      strings(node.arguments[0]).forEach((s) => push(node, s));
    } else if (ts.isCallExpression(node) && ['send', 'sendStatus'].includes(calleeName(node.expression)) && node.arguments.length) {
      strings(node.arguments[0]).forEach((s) => push(node, s));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** The "error" field of a Python script's JSON: error="..." or "error": "..." (an f-string is fine). */
export function scriptErrors(source: string): { line: number; text: string }[] {
  const found: { line: number; text: string }[] = [];
  source.split('\n').forEach((line, i) => {
    if (line.trimStart().startsWith('#')) return;
    for (const m of line.matchAll(/(?:\berror\s*=|"error"\s*:)\s*f?(["'])((?:(?!\1).)*)\1/g)) found.push({ line: i + 1, text: m[2] });
  });
  return found;
}

describe('French messages sent or thrown by the server', () => {
  describe('the detectors themselves (so that they cannot go quiet by mistake)', () => {
    const french = (code: string) => serverMessages(code).filter((m) => looksFrench(m.text)).map((m) => m.text);

    it('sees a response, a thrown error and a send()', () => {
      expect(french("res.status(400).json({ error: 'Aucun fichier audio recu (champ \"audio\" attendu).' });")).toEqual(['Aucun fichier audio recu (champ "audio" attendu).']);
      expect(french("throw new Error('Échec de la conversion');")).toEqual(['Échec de la conversion']);
      expect(french("res.status(500).send('Erreur interne.');")).toEqual(['Erreur interne.']);
      expect(french('reject(new Error(`Separation interrompue apres ${n}s (timeout).`));')).toEqual(['Separation interrompue apres ${…}s (timeout).']);
    });

    it('does not flag English, a log line, or a comment', () => {
      expect(french("res.status(400).json({ error: 'No audio file received (field \"audio\" expected).' });")).toEqual([]);
      expect(french("console.error('[Training] Erreur de lecture du fichier', e);")).toEqual([]);
      expect(french("// Aucun fichier audio recu\nconst a = 1;")).toEqual([]);
    });

    it('sees the error field of a Python script, and not its log lines', () => {
      expect(scriptErrors('emit_result(False, error=f"Echec de l\'inference : {e}")').map((m) => m.text)).toEqual(["Echec de l'inference : {e}"]);
      expect(scriptErrors('print(json.dumps({"success": False, "error": "Usage: x"}))').map((m) => m.text)).toEqual(['Usage: x']);
      expect(scriptErrors('print(f"[demucs] ERREUR : {e}", file=sys.stderr)')).toEqual([]);
      expect(scriptErrors('# error="Echec"')).toEqual([]);
      expect(looksFrench("Echec de l'inference : {e}")).toBe(true);
      expect(looksFrench('Inference failed: {e}')).toBe(false);
    });

    it('reports where it found it', () => {
      expect(serverMessages("const a = 1;\nconst b = { error: 'Erreur interne.' };")).toEqual([{ line: 2, text: 'Erreur interne.' }]);
    });
  });

  describe('the server', () => {
    const SERVER_SRC = __dirname;
    const SCRIPTS = path.resolve(__dirname, '../scripts');
    const tsFiles = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) return ['node_modules', 'dist'].includes(e.name) ? [] : tsFiles(full);
        return /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name) ? [full] : [];
      });

    it('scans the files it is meant to scan', () => {
      expect(tsFiles(SERVER_SRC).length).toBeGreaterThan(30); // guards the scan itself against silently reading nothing
      expect(fs.readdirSync(SCRIPTS).filter((f) => f.endsWith('.py')).length).toBeGreaterThan(3);
    });

    it('sends and throws no French message', () => {
      const offenders: string[] = [];
      for (const file of tsFiles(SERVER_SRC)) {
        for (const { line, text } of serverMessages(fs.readFileSync(file, 'utf-8'), file)) {
          if (looksFrench(text)) offenders.push(`src/${path.relative(SERVER_SRC, file)}:${line}  « ${text.slice(0, 80)} »`);
        }
      }
      expect(offenders, 'a French message reaches the interface as it is: write it in English').toEqual([]);
    });

    it('has no French message in the error field of a Python script', () => {
      const offenders: string[] = [];
      for (const name of fs.readdirSync(SCRIPTS).filter((f) => f.endsWith('.py'))) {
        for (const { line, text } of scriptErrors(fs.readFileSync(path.join(SCRIPTS, name), 'utf-8'))) {
          if (looksFrench(text)) offenders.push(`scripts/${name}:${line}  « ${text.slice(0, 80)} »`);
        }
      }
      expect(offenders, 'the server forwards this field to the interface as it is: write it in English').toEqual([]);
    });
  });
});
