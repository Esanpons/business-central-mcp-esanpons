// src/protocol/section-resolver.ts
import { tryBuildFormTree } from './form-tree-builder.js';
import { repeaters as treeRepeaters } from './form-views.js';
import type { PageContext } from './page-context.js';
import type { FormState } from './form-state.js';
import type { RepeaterRow } from './types.js';
import type { FormNode, RepeaterNode } from './form-node.js';

export type SectionKind = 'header' | 'lines' | 'factbox' | 'requestPage' | 'subpage' | 'dialog';

export interface SectionDescriptor {
  readonly sectionId: string;
  readonly kind: SectionKind;
  readonly caption: string;
  readonly formId: string;
  readonly repeaterControlPath?: string;
  readonly valid: boolean;
}

export interface ResolvedSection {
  section: SectionDescriptor;
  form: FormState;
  repeater: RepeaterNode | null;
  rows: readonly RepeaterRow[];
}

export interface DeriveSectionOptions {
  /**
   * BC's `IsSubForm` for this child. ONLY a true subform is a document's `lines`
   * section. Any other part that happens to contain a repeater (an ordinary
   * ListPart embedded on a Card, a Role Center CardPart with a list) is a
   * `subpage` — classifying it as `lines` made the host page report itself as a
   * Document. Defaults to false: absent evidence, do not claim it is the lines.
   */
  readonly isSubForm?: boolean;
  /**
   * Already-parsed tree for `childControlTree`. Pass it when the caller has one
   * (the repo builds it anyway) so the tree is not parsed twice per child form.
   */
  readonly root?: FormNode | null;
}

export class SectionResolver {
  createHeaderSection(rootFormId: string): SectionDescriptor {
    return { sectionId: 'header', kind: 'header', caption: 'Header', formId: rootFormId, valid: true };
  }

  deriveSection(
    parentPageContext: PageContext,
    childFormId: string,
    childControlTree: unknown,
    options?: DeriveSectionOptions,
  ): SectionDescriptor {
    // Build the child form's tree to inspect repeater structure. BC normally
    // sends child form trees as raw lf JSON, but occasionally a partial/placeholder
    // payload arrives (the same case tryBuildFormTree tolerates elsewhere). A hard
    // throw here would abort the whole event batch and leave the page context
    // half-updated, so fall back to a plain subpage descriptor instead.
    const childRoot = options?.root ?? tryBuildFormTree(childControlTree);
    if (!childRoot) {
      const id = this.uniqueSectionId(parentPageContext, 'subpage');
      return { sectionId: id, kind: 'subpage', caption: 'Subpage', formId: childFormId, valid: true };
    }
    const reps = treeRepeaters(childRoot);
    const repeaterPath = reps.size > 0 ? reps.keys().next().value : undefined;

    if (repeaterPath && options?.isSubForm) {
      const id = this.uniqueSectionId(parentPageContext, 'lines');
      return {
        sectionId: id, kind: 'lines',
        caption: childRoot.properties.caption || 'Lines',
        formId: childFormId,
        repeaterControlPath: repeaterPath,
        valid: true,
      };
    }

    // A part with a repeater is still a subpage — but keep the repeater path so
    // its rows are readable and refreshable exactly like a lines section's.
    const caption = childRoot.properties.caption || 'Subpage';
    const id = this.uniqueSectionId(parentPageContext, `subpage:${caption}`);
    return {
      sectionId: id, kind: 'subpage', caption, formId: childFormId,
      ...(repeaterPath ? { repeaterControlPath: repeaterPath } : {}),
      valid: true,
    };
  }

  /**
   * Descriptor for a child form that BC published as a PART (IsSubForm=false):
   * FactBoxes on a Card, and Role Center hosted CardParts, which arrive with the
   * same wire shape. Lives here — not in the repository — so every sectionId in a
   * context is minted by the same uniqueness rule.
   */
  deriveFactboxSection(
    parentPageContext: PageContext,
    child: { readonly serverId: string; readonly caption: string },
  ): SectionDescriptor {
    const caption = child.caption || 'FactBox';
    const sectionId = this.uniqueSectionId(parentPageContext, `factbox:${caption}`);
    return { sectionId, kind: 'factbox', caption, formId: child.serverId, valid: true };
  }

  /**
   * Descriptor for an open MODAL DIALOG, so it can be read from and written to like
   * any other part of the page.
   *
   * A dialog with fields used to be unreachable: it was kept only as a raw entry in
   * `PageContext.dialogs`, never built into a form and never given a section, so
   * bc_write_data — which resolves everything through sections — answered "Field not
   * found" for a control whose exact controlPath the very same response had just
   * handed the caller. Anything BC gated behind a dialog with mandatory fields could
   * be opened and cancelled but never completed, which is what forced a person to
   * take over mid-workflow (bc-saas F-4/F-5).
   *
   * The FIRST open dialog is plainly `dialog`, so a caller can name it without
   * looking anything up; a second concurrent one gets `dialog#2`. The id is released
   * when the dialog closes (see markFormClosed), so ids do not creep upwards over a
   * long-lived page.
   */
  deriveDialogSection(ctx: PageContext, dialogFormId: string, caption?: string): SectionDescriptor {
    return {
      sectionId: this.uniqueSectionId(ctx, 'dialog'),
      kind: 'dialog',
      caption: caption || 'Dialog',
      formId: dialogFormId,
      valid: true,
    };
  }

  private uniqueSectionId(ctx: PageContext, base: string): string {
    if (!ctx.sections.has(base)) return base;
    for (let i = 2; ; i++) {
      const candidate = `${base}#${i}`;
      if (!ctx.sections.has(candidate)) return candidate;
    }
  }
}

export function resolveSection(
  ctx: PageContext,
  sectionId?: string,
  defaultSection?: string,
): ResolvedSection | { error: string; availableSections: string[] } {
  const id = sectionId ?? defaultSection ?? 'header';
  const section = ctx.sections.get(id);
  if (!section) {
    return { error: `Section '${id}' not found.`, availableSections: Array.from(ctx.sections.keys()) };
  }
  if (!section.valid) {
    return {
      error: `Section '${id}' is no longer available. The page may have been modified. Try re-opening the page.`,
      availableSections: Array.from(ctx.sections.keys()).filter(s => ctx.sections.get(s)?.valid !== false),
    };
  }
  const form = ctx.forms.get(section.formId);
  if (!form) {
    return { error: `Form for section '${id}' not found (formId: ${section.formId}).`, availableSections: Array.from(ctx.sections.keys()) };
  }
  const reps = treeRepeaters(form.root);
  const repeater = section.repeaterControlPath
    ? (reps.get(section.repeaterControlPath) ?? null)
    : (reps.size > 0 ? reps.values().next().value! : null);
  const rows = repeater ? (form.rows.get(repeater.controlPath) ?? []) : [];
  return { section, form, repeater, rows };
}
