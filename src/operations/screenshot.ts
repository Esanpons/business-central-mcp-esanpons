import { ok, err, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { ScreenshotService, CaptureInput } from '../services/screenshot-service.js';

export interface ScreenshotInput {
  pageId: string | number;
  bookmark?: string;
  company?: string;
  highlight?: string;
  out?: string;
  width?: number;
  height?: number;
  scale?: number;
  fullPage?: boolean;
  inline?: boolean;
}

export interface ScreenshotOutput {
  path: string;
  url: string;
  pageTitle: string;
  authenticated: boolean;
  spaReady: boolean;
  highlight?: { requested: string; found: boolean };
  width: number;
  height: number;
  /** When inline is requested, the PNG is also returned so the caller can see it. */
  __image?: { data: string; mimeType: string };
}

export class ScreenshotOperation {
  constructor(private readonly service: ScreenshotService) {}

  async execute(input: ScreenshotInput): Promise<Result<ScreenshotOutput, ProtocolError>> {
    const inline = input.inline !== false; // default: return the image inline
    const captureInput: CaptureInput = {
      pageId: String(input.pageId),
      bookmark: input.bookmark,
      company: input.company,
      highlight: input.highlight,
      out: input.out,
      width: input.width,
      height: input.height,
      scale: input.scale,
      fullPage: input.fullPage,
      inline,
    };
    try {
      const r = await this.service.capture(captureInput);
      const { base64, ...rest } = r;
      return ok({
        ...rest,
        __image: base64 ? { data: base64, mimeType: 'image/png' } : undefined,
      });
    } catch (e) {
      return err(new ProtocolError(e instanceof Error ? e.message : String(e), undefined, 'SCREENSHOT_ERROR'));
    }
  }
}
