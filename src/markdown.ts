/**
 * iMessage format conversion using AST-based parsing.
 *
 * Remote iMessage (via spectrum-ts) renders CommonMark natively as styled text
 * (bold/italic/links etc. via UTF-16 formatting ranges), so markdown-typed
 * outbound content is sent through spectrum's `markdown()` builder verbatim --
 * see `renderPostableContent`. The plain-text rendering here (`fromAst`) is
 * still used for inbound parsing, `renderFormatted`, and the raw/card fallback
 * paths: it strips formatting markers and preserves structure (lists,
 * blockquotes, code blocks) with whitespace.
 */

import {
  type AdapterPostableMessage,
  BaseFormatConverter,
  type Content,
  getNodeChildren,
  getNodeValue,
  isBlockquoteNode,
  isCodeNode,
  isDeleteNode,
  isEmphasisNode,
  isInlineCodeNode,
  isLinkNode,
  isListItemNode,
  isListNode,
  isParagraphNode,
  isStrongNode,
  isTextNode,
  parseMarkdown,
  type Root,
  stringifyMarkdown,
} from "chat";

/**
 * The spectrum content a postable message should be sent as: the body string
 * plus whether spectrum should render it as native markdown (styled text) or
 * pass it through as plain text.
 */
export interface PostableContent {
  body: string;
  markdown: boolean;
}

export class iMessageFormatConverter extends BaseFormatConverter {
  /**
   * Render an AST to iMessage plain text format.
   * Strips all formatting markers since iMessage doesn't support rich text via API.
   */
  fromAst(ast: Root): string {
    return this.fromAstWithNodeConverter(ast, (node) =>
      this.nodeToPlainText(node)
    );
  }

  /**
   * Parse iMessage text into an AST.
   * iMessage sends plain text, so we just parse it as markdown.
   */
  toAst(text: string): Root {
    return parseMarkdown(text);
  }

  /**
   * Decide how a postable message should reach spectrum-ts.
   *
   * Markdown-typed inputs -- `{ markdown }` and `{ ast }` -- carry CommonMark
   * the caller wants styled, so their source is preserved verbatim and flagged
   * `markdown: true`; the adapter sends it via spectrum's `markdown()` builder,
   * which renders bold/italic/links/lists as native iMessage styled text.
   *
   * Everything else is pass-through-as-is by contract -- a plain `string` or
   * `{ raw }` must not have stray `*`/`_` reinterpreted as formatting, and
   * cards fall back to plain text -- so those are rendered to plain text and
   * flagged `markdown: false`.
   */
  renderPostableContent(message: AdapterPostableMessage): PostableContent {
    if (message && typeof message === "object") {
      if ("markdown" in message && typeof message.markdown === "string") {
        return { body: message.markdown, markdown: true };
      }
      if ("ast" in message && message.ast) {
        return { body: stringifyMarkdown(message.ast), markdown: true };
      }
    }
    return { body: this.renderPostable(message), markdown: false };
  }

  private nodeToPlainText(node: Content): string {
    if (isParagraphNode(node)) {
      return getNodeChildren(node)
        .map((child) => this.nodeToPlainText(child))
        .join("");
    }

    if (isTextNode(node)) {
      return node.value;
    }

    if (isStrongNode(node) || isEmphasisNode(node) || isDeleteNode(node)) {
      return getNodeChildren(node)
        .map((child) => this.nodeToPlainText(child))
        .join("");
    }

    if (isInlineCodeNode(node)) {
      return node.value;
    }

    if (isCodeNode(node)) {
      return node.value;
    }

    if (isLinkNode(node)) {
      const linkText = getNodeChildren(node)
        .map((child) => this.nodeToPlainText(child))
        .join("");
      return linkText ? `${linkText} (${node.url})` : node.url;
    }

    if (isBlockquoteNode(node)) {
      return getNodeChildren(node)
        .map((child) => `> ${this.nodeToPlainText(child)}`)
        .join("\n");
    }

    if (isListNode(node)) {
      return getNodeChildren(node)
        .map((item, i) => {
          const prefix = node.ordered ? `${i + 1}.` : "-";
          const content = getNodeChildren(item)
            .map((child) => this.nodeToPlainText(child))
            .join("");
          return `${prefix} ${content}`;
        })
        .join("\n");
    }

    if (isListItemNode(node)) {
      return getNodeChildren(node)
        .map((child) => this.nodeToPlainText(child))
        .join("");
    }

    if (node.type === "break") {
      return "\n";
    }

    if (node.type === "thematicBreak") {
      return "---";
    }

    const children = getNodeChildren(node);
    if (children.length > 0) {
      return children.map((child) => this.nodeToPlainText(child)).join("");
    }
    return getNodeValue(node);
  }
}
