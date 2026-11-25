import type { OpenAPIV3 } from 'openapi-types';

import api, { adminTenantApi, authedAdminApi, authedAdminTenantApi } from '#src/api/api.js';
import { deleteUser, suspendUser } from '#src/api/index.js';
import { isDevFeaturesEnabled } from '#src/constants.js';
import { createUserByAdmin } from '#src/helpers/index.js';

describe('GET /users/:userId/exists', () => {
  it('only documents the endpoint when dev features are enabled', async () => {
    const document = await adminTenantApi
      .get('.well-known/management.openapi.json')
      .json<OpenAPIV3.Document>();
    const operation = document.paths['/api/users/{userId}/exists']?.get;

    if (isDevFeaturesEnabled) {
      expect(operation).toBeDefined();
    } else {
      expect(operation).toBeUndefined();
    }
  });

  const itWithDevFeatures = isDevFeaturesEnabled ? it : it.skip;

  itWithDevFeatures('checks tenant-local existence, including suspended users', async () => {
    const { id } = await createUserByAdmin();
    const path = `users/${encodeURIComponent(id)}/exists`;

    try {
      await expect(authedAdminApi.get(path).json()).resolves.toEqual({ exists: true });
      await expect(authedAdminTenantApi.get(path).json()).resolves.toEqual({ exists: false });

      await suspendUser(id, true);
      await expect(authedAdminApi.get(path).json()).resolves.toEqual({ exists: true });
    } finally {
      await deleteUser(id);
    }

    await expect(authedAdminApi.get(path).json()).resolves.toEqual({ exists: false });
  });

  itWithDevFeatures('requires Management API authentication', async () => {
    const response = await api.get('users/unknown-user/exists', { throwHttpErrors: false });
    expect(response.status).toBe(401);
  });
});
