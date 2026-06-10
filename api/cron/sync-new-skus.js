import syncNewSkusHandler from '../sync-new-skus.js';

export default async function handler(request, response) {
  return syncNewSkusHandler(request, response);
}
