import {
  InteractionRequiredAuthError,
  PublicClientApplication,
  type AccountInfo,
} from '@azure/msal-node';
import { OneNoteError, type OneNoteConfig } from './onenote.ts';

const GRAPH_SCOPES = ['Notes.Read'];

export function createOneNoteTokenProvider(config: OneNoteConfig): () => Promise<string> {
  const application = new PublicClientApplication({
    auth: {
      clientId: config.clientId,
      authority: `https://login.microsoftonline.com/${config.tenantId}`,
    },
  });
  let account: AccountInfo | undefined;
  let pending: Promise<string> | undefined;

  return async () => {
    if (pending) return pending;
    pending = (async () => {
      if (account) {
        try {
          const cached = await application.acquireTokenSilent({ scopes: GRAPH_SCOPES, account });
          if (cached?.accessToken) return cached.accessToken;
        } catch (error) {
          if (!(error instanceof InteractionRequiredAuthError)) {
            throw new OneNoteError('Unable to acquire a Microsoft Graph access token.');
          }
        }
      }

      const acquired = await application.acquireTokenByDeviceCode({
        scopes: GRAPH_SCOPES,
        deviceCodeCallback: ({ message }) => {
          process.stderr.write(`OneNote sign-in required: ${message}\n`);
        },
      }).catch(() => {
        throw new OneNoteError('Microsoft sign-in did not complete; no access token was acquired.');
      });
      if (!acquired?.accessToken || !acquired.account) {
        throw new OneNoteError('Microsoft sign-in completed without an access token.');
      }
      account = acquired.account;
      return acquired.accessToken;
    })();

    try {
      return await pending;
    } finally {
      pending = undefined;
    }
  };
}
