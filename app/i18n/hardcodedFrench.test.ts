// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';

// Fails when a component shows French text that does not go through t() or tf(). Such text is displayed as it is in EVERY language:
// "Rien à envoyer au moteur…", "Séparation en cours…", "Service prêt" were seen by English speakers.
//
// It reads the code the way the compiler does (syntax tree), in the places where text reaches the screen: text between JSX tags, the
// title / placeholder / alt / aria-label / label attributes, the value of an expression shown in JSX ({a ? 'x' : 'y'}, {a || 'x'}),
// messages handed to a notification or an error setter (showToast, setError, set…Status…), thrown error messages, and the label /
// description / title / message properties of configuration objects. A comparison (mode === 'ready') shows nothing and is ignored.
//
// Blind spots, by construction: a text kept in a variable or returned by a function and displayed further away; and French words
// without an accent that the word list below does not know. The accent test and the word list are a heuristic, not a dictionary.
//
// Not covered here: the fallback of a missing key, t('key') || 'texte'. usedKeys.test.ts (KNOWN_GAP) and fallbackKeys.test.ts own that.

const ACCENT = /[àâäçéèêëîïôöûùüÿœ]/i;
const STRONG = /\b(ajouter|supprimer|fermer|ouvrir|annuler|valider|enregistrer|sauvegarder|chargement|charger|erreur|echec|fichier|chanson|morceau|paroles|creer|generer|telecharger|rechercher|bientot|choisir|selectionner|modifier|aucun|aucune|normaliser|separation|pistes|dossier|vitesse|prolonger|rogner|inverser|demarrage|arret|reseau)\b/i;
const FUNC = /\b(le|la|les|des|du|un|une|pour|avec|sans|dans|sur|est|sont|pas|vous|votre|ton|tes|ou|et|au|aux|ces|cette)\b/gi;

export function looksFrench(text: string): boolean {
  const s = text.replace(/\$\{[^}]*\}|\{\{[^}]*\}\}/g, ' ');
  return ACCENT.test(s) || STRONG.test(s) || (s.match(FUNC) ?? []).length >= 2;
}

// A text that is French on purpose (a language's own name, for instance). Empty today.
const ALLOWED: readonly string[] = [];

const ATTRS = new Set(['title', 'placeholder', 'alt', 'aria-label', 'label', 'tooltip', 'description', 'text', 'subtitle', 'helperText']);
const PROP_KEYS = new Set(['label', 'short', 'desc', 'description', 'title', 'placeholder', 'message', 'text', 'tooltip', 'hint', 'subtitle', 'heading', 'caption']);
const NOTIFY_CALLEES = /^(showToast|toast|alert|confirm|prompt|notify)$/;
const NOTIFY_SETTERS = /^set\w*(Error|Message|Status|Toast|Notice|Warning|Info)$/;

const calleeName = (e: ts.Expression): string => (ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : '');
const isTranslationCall = (e: ts.Expression): boolean => ts.isCallExpression(e) && ['t', 'tf'].includes(calleeName(e.expression));

/** The strings an expression can show, without going through a call (so never into t(...)). */
function strings(node: ts.Node | undefined): string[] {
  if (!node) return [];
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isTemplateExpression(node)) return [node.head.text + node.templateSpans.map((s) => '${…}' + s.literal.text).join('')];
  if (ts.isConditionalExpression(node)) return [...strings(node.whenTrue), ...strings(node.whenFalse)];
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return strings(node.expression);
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
      return isTranslationCall(node.left) ? [] : [...strings(node.left), ...strings(node.right)]; // t('key') || 'texte' is another test's job
    }
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return strings(node.right);
    if (op === ts.SyntaxKind.PlusToken) return [...strings(node.left), ...strings(node.right)];
  }
  return [];
}

export function displayedStrings(source: string, fileName = 'fixture.tsx'): { line: number; text: string }[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: { line: number; text: string }[] = [];
  const push = (node: ts.Node, text: string) => {
    const t = text.replace(/\s+/g, ' ').trim();
    if (t) found.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: t });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      const t = node.getText(sf).replace(/\s+/g, ' ').trim();
      if (/\p{L}/u.test(t)) push(node, t);
    } else if (ts.isJsxAttribute(node)) {
      if (ATTRS.has(node.name.getText(sf)) && node.initializer) {
        if (ts.isStringLiteral(node.initializer)) push(node, node.initializer.text);
        else if (ts.isJsxExpression(node.initializer)) strings(node.initializer.expression).forEach((s) => push(node, s));
      }
    } else if (ts.isJsxExpression(node) && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      strings(node.expression).forEach((s) => push(node, s));
    } else if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if ((NOTIFY_CALLEES.test(name) || NOTIFY_SETTERS.test(name)) && node.arguments.length) strings(node.arguments[0]).forEach((s) => push(node, s));
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && /Error$/.test(node.expression.text) && node.arguments?.length) {
      strings(node.arguments[0]).forEach((s) => push(node, s));
    } else if (ts.isPropertyAssignment(node)) {
      const key = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : '';
      if (PROP_KEYS.has(key)) strings(node.initializer).forEach((s) => push(node, s));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe('French text written directly in the interface', () => {
  describe('the detector itself (so that it cannot go quiet by mistake)', () => {
    const french = (code: string) => displayedStrings(code).filter((f) => looksFrench(f.text)).map((f) => f.text);

    it('sees text between tags, in attributes, in expressions, in errors and in configuration objects', () => {
      expect(french('const A = () => <p>Fermer la fenêtre</p>;')).toEqual(['Fermer la fenêtre']);
      expect(french('const A = () => <button title="Télécharger">x</button>;')).toEqual(['Télécharger']);
      expect(french("const A = () => <p>{open ? 'Fermer' : 'Ouvrir'}</p>;")).toEqual(['Fermer', 'Ouvrir']);
      expect(french("const f = () => setError('Erreur réseau.');")).toEqual(['Erreur réseau.']);
      expect(french("const f = () => { throw new Error('Échec de la séparation.'); };")).toEqual(['Échec de la séparation.']);
      expect(french("const MODES = [{ label: 'Prolonger', desc: 'Prolonge le morceau' }];")).toEqual(['Prolonger', 'Prolonge le morceau']);
    });

    it('sees an unaccented French sentence', () => {
      expect(french('const A = () => <p>Separation en cours</p>;')).toEqual(['Separation en cours']);
      expect(french('const A = () => <p>Dossier de sortie</p>;')).toEqual(['Dossier de sortie']);
    });

    it('does not flag English text, a comparison, or a translated text', () => {
      expect(french('const A = () => <p>Close the window</p>;')).toEqual([]);
      expect(french("const A = () => <p>{mode === 'ready' && 'prêt'}</p>;").includes('prêt')).toBe(true); // shown when true: a real display
      expect(french("const A = () => mode === 'prêt' ? 1 : 2;")).toEqual([]); // a comparison shows nothing
      expect(french("const A = () => <p>{t('close')}</p>;")).toEqual([]);
    });

    it('leaves the fallback of a missing key to the other tests', () => {
      expect(french("const A = () => <p>{t('close') || 'Fermer'}</p>;")).toEqual([]);
      expect(french("const A = () => <p>{tf('close', 'Fermer')}</p>;")).toEqual([]);
    });

    it('reports where it found it', () => {
      expect(displayedStrings('const A = () => (\n  <div>\n    <p>Fermer</p>\n  </div>\n);')).toEqual([{ line: 3, text: 'Fermer' }]);
    });
  });

  describe('the interface', () => {
    const APP_DIR = path.resolve(__dirname, '..');
    const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'i18n', 'server', 'docs', 'audiomass-editor', 'data']);
    const sourceFiles = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : sourceFiles(full);
        return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !/\.d\.ts$/.test(entry.name) ? [full] : [];
      });

    it('scans the components it is meant to scan', () => {
      expect(sourceFiles(APP_DIR).length).toBeGreaterThan(60); // guards the scan itself against silently reading nothing
    });

    it('has no French text outside the translation functions', () => {
      const offenders: string[] = [];
      for (const file of sourceFiles(APP_DIR)) {
        for (const { line, text } of displayedStrings(fs.readFileSync(file, 'utf-8'), file)) {
          if (looksFrench(text) && !ALLOWED.includes(text)) offenders.push(`${path.relative(APP_DIR, file)}:${line}  « ${text.slice(0, 80)} »`);
        }
      }
      expect(offenders, 'French text shown as it is in every language: give it a key in the six language files and use t()').toEqual([]);
    });
  });
});
