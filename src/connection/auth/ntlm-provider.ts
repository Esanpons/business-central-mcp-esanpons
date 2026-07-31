import * as cheerio from 'cheerio';
import { ok, err, type Result } from '../../core/result.js';
import { AuthenticationError } from '../../core/errors.js';
import type { IBCAuthProvider, AuthResult } from './auth-provider.js';
import type { Logger } from '../../core/logger.js';

interface NTLMProviderConfig {
  baseUrl: string;
  username: string;
  password: string;
  tenantId: string;
}

export class NTLMAuthProvider implements IBCAuthProvider {
  private cookies = '';
  private csrfToken = '';
  private authenticated = false;

  constructor(
    private readonly config: NTLMProviderConfig,
    private readonly logger: Logger
  ) {}

  async authenticate(): Promise<Result<AuthResult, AuthenticationError>> {
    try {
      // Step 1: GET /SignIn
      const signInUrl = `${this.config.baseUrl}/SignIn?tenant=${this.config.tenantId}`;
      const getResponse = await fetch(signInUrl, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'User-Agent': 'BCMCPServer/2.0' },
      });

      const setCookies = getResponse.headers.getSetCookie?.() ?? [];
      this.cookies = setCookies.map(c => c.split(';')[0]!).join('; ');

      const html = await getResponse.text();
      const $ = cheerio.load(html);
      const verificationToken = $('input[name="__RequestVerificationToken"]').val() as string;

      if (!verificationToken) {
        return err(new AuthenticationError('Failed to extract __RequestVerificationToken from login page'));
      }

      // Step 2: POST /SignIn
      const postBody = new URLSearchParams({
        userName: this.config.username,
        password: this.config.password,
        __RequestVerificationToken: verificationToken,
      });

      const postResponse = await fetch(signInUrl, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cookie': this.cookies,
          'User-Agent': 'BCMCPServer/2.0',
        },
        body: postBody.toString(),
      });

      // Merge updated cookies into a name->value map (used below for both the
      // auth-success check and CSRF extraction).
      const cookieMap = new Map(this.cookies.split('; ').filter(c => c).map(c => {
        const eqIdx = c.indexOf('=');
        return eqIdx >= 0 ? [c.substring(0, eqIdx), c.substring(eqIdx + 1)] as [string, string] : [c, ''] as [string, string];
      }));
      const postCookies = postResponse.headers.getSetCookie?.() ?? [];
      for (const cookie of postCookies) {
        const [nameValue] = cookie.split(';');
        if (nameValue) {
          const eqIdx = nameValue.indexOf('=');
          if (eqIdx >= 0) {
            cookieMap.set(nameValue.substring(0, eqIdx), nameValue.substring(eqIdx + 1));
          }
        }
      }
      this.cookies = Array.from(cookieMap.entries()).map(([k, v]) => `${k}=${v}`).join('; ');

      // Detect a failed sign-in. A successful POST /SignIn answers with a 302
      // redirect AND sets the auth-ticket cookie `.AspNetCore.Cookies`. A wrong
      // password returns 200 with the login page re-rendered and NO auth ticket.
      // The old code accepted that silently (the antiforgery cookie from the GET
      // was enough to extract a CSRF token), so the failure only surfaced later
      // as an opaque WebSocket/OpenSession error and burned a full reconnect cycle.
      const hasAuthTicket = [...cookieMap.keys()].some(k => k.startsWith('.AspNetCore.Cookies'));
      const isRedirect = postResponse.status >= 300 && postResponse.status < 400;
      if (!hasAuthTicket && !isRedirect) {
        return err(new AuthenticationError(
          `Invalid username or password for ${this.config.baseUrl} (Business Central did not establish a session for user "${this.config.username}").`,
          { baseUrl: this.config.baseUrl, username: this.config.username, status: postResponse.status },
        ));
      }

      // Extract the CSRF token from the antiforgery cookie, identified by NAME
      // (.AspNetCore.Antiforgery.*). Matching by the CfDJ8 value prefix was
      // fragile: that prefix is shared by every ASP.NET Core data-protection
      // cookie (including the auth ticket), so correctness depended on insertion
      // order. Fall back to the first CfDJ8 value only if no named antiforgery
      // cookie exists.
      for (const [name, value] of cookieMap) {
        if (name.startsWith('.AspNetCore.Antiforgery.')) {
          this.csrfToken = value;
          break;
        }
      }
      if (!this.csrfToken) {
        for (const value of cookieMap.values()) {
          if (value.startsWith('CfDJ8')) { this.csrfToken = value; break; }
        }
      }

      if (!this.csrfToken) {
        return err(new AuthenticationError('Failed to extract CSRF token from antiforgery cookie'));
      }

      this.authenticated = true;
      this.logger.info(`Authenticated as ${this.config.username} to ${this.config.baseUrl}`);
      return ok({ cookies: this.cookies, csrfToken: this.csrfToken });

    } catch (e) {
      return err(new AuthenticationError(
        `Authentication failed: ${e instanceof Error ? e.message : String(e)}`,
        { baseUrl: this.config.baseUrl, username: this.config.username }
      ));
    }
  }

  getWebSocketHeaders(): Record<string, string> {
    return { Cookie: this.cookies };
  }

  getWebSocketQueryParams(): Record<string, string> {
    return { csrftoken: this.csrfToken };
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  invalidate(): void {
    // Hard-reset de l'estat d'auth: deixa el singleton com acabat de crear
    // perquè el següent connect refaci GET+POST /SignIn (cookies/CSRF nous).
    // Necessari després d'un publish: el NST recicla l'app domain i invalida
    // server-side les cookies forms-auth, però el flag authenticated seguia true
    // i el gate de ConnectionFactory saltava el re-login amb credencials mortes.
    this.authenticated = false;
    this.cookies = '';
    this.csrfToken = '';
    this.logger.info('Auth state invalidated; next connection will re-sign-in');
  }
}
