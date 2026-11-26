import { generateStandardId } from '@logto/shared';

import { createUser, deleteUser } from '#src/api/admin-user.js';
import { authedAdminApi } from '#src/api/api.js';
import { isDevFeaturesEnabled } from '#src/constants.js';
import { expectRejects } from '#src/helpers/index.js';
import { OrganizationApiTest, OrganizationInvitationApiTest } from '#src/helpers/organization.js';

const randomId = () => generateStandardId(4);

describe('organization invitation creation', () => {
  const invitationApi = new OrganizationInvitationApiTest();
  const organizationApi = new OrganizationApiTest();

  const createInvitation = async (organizationId: string) =>
    invitationApi.create({
      organizationId,
      invitee: `${randomId()}@example.com`,
      expiresAt: Date.now() + 1_000_000,
    });

  afterEach(async () => {
    await Promise.all([
      organizationApi.cleanUp(),
      organizationApi.roleApi.cleanUp(),
      invitationApi.cleanUp(),
    ]);
  });

  it('should be able to get invitations by organization id and inviter id', async () => {
    const organization1 = await organizationApi.create({ name: 'test' });
    const organization2 = await organizationApi.create({ name: 'test' });
    const inviter = await createUser({ primaryEmail: 'foo@bar.io' });
    const inviter2 = await createUser({ primaryEmail: 'bar@baz.io' });

    // eslint-disable-next-line unicorn/consistent-function-scoping
    const buildPayload = (inviterId: string, organizationId: string) => ({
      organizationId,
      inviterId,
      invitee: `${randomId()}@example.com`,
      expiresAt: Date.now() + 1_000_000,
    });

    await Promise.all([
      invitationApi.create(buildPayload(inviter.id, organization1.id)),
      invitationApi.create(buildPayload(inviter.id, organization2.id)),
      invitationApi.create(buildPayload(inviter2.id, organization1.id)),
    ]);

    const invitationsByOrganization1 = await invitationApi.getList(
      new URLSearchParams({ organizationId: organization1.id })
    );
    expect(invitationsByOrganization1.length).toBe(2);
    expect(
      invitationsByOrganization1.every(
        (invitation) => invitation.organizationId === organization1.id
      )
    ).toBe(true);

    const invitationsByInviter = await invitationApi.getList(
      new URLSearchParams({ inviterId: inviter.id })
    );
    expect(invitationsByInviter.length).toBe(2);
    expect(invitationsByInviter.every((invitation) => invitation.inviterId === inviter.id)).toBe(
      true
    );

    const allInvitations = await invitationApi.getList();
    expect(allInvitations.length).toBe(3);

    await Promise.all([deleteUser(inviter.id), deleteUser(inviter2.id)]);
  });

  it('should be able to get invitations by invitee email (case insensitive)', async () => {
    const organization = await organizationApi.create({ name: 'test' });
    const invitee = `${randomId()}@example.com`;
    await invitationApi.create({
      organizationId: organization.id,
      // Deliberately use uppercase email when creating the invitation
      invitee: invitee.toUpperCase(),
      expiresAt: Date.now() + 1_000_000,
    });

    const invitations = await invitationApi.getList(new URLSearchParams({ invitee }));
    expect(invitations.length).toBe(1);
    expect(invitations[0]?.invitee.toLocaleLowerCase()).toBe(invitee.toLowerCase());
  });

  it('should return all matching invitations when pagination parameters are omitted', async () => {
    const organization = await organizationApi.create({ name: 'test' });
    await Promise.all(
      Array.from({ length: 30 }, async () =>
        invitationApi.create({
          organizationId: organization.id,
          invitee: `${randomId()}@example.com`,
          expiresAt: Date.now() + 1_000_000,
        })
      )
    );

    const invitations = await invitationApi.getList(
      new URLSearchParams({ organizationId: organization.id })
    );
    expect(invitations.length).toBe(30);
  });

  it('should paginate matching invitations only when pagination is enabled', async () => {
    const organization = await organizationApi.create({ name: 'test' });
    const otherOrganization = await organizationApi.create({ name: 'test' });
    const first = await createInvitation(organization.id);
    const second = await createInvitation(organization.id);
    await createInvitation(otherOrganization.id);

    const fetchPage = async (page: number) =>
      authedAdminApi.get('organization-invitations', {
        searchParams: new URLSearchParams({
          organizationId: organization.id,
          page: String(page),
          page_size: '1',
        }),
      });

    const pageOne = await fetchPage(1);

    if (!isDevFeaturesEnabled) {
      expect(pageOne.headers.has('Total-Number')).toBe(false);
      expect(pageOne.headers.has('Link')).toBe(false);
      expect(await pageOne.json()).toHaveLength(2);
      return;
    }

    expect(pageOne.headers.get('Total-Number')).toBe('2');
    expect(pageOne.headers.get('Link')).toContain(
      `organizationId=${organization.id}&page=2&page_size=1>; rel="next"`
    );

    const pageTwo = await fetchPage(2);
    expect(pageTwo.headers.get('Total-Number')).toBe('2');
    const pages = await Promise.all([pageOne.json(), pageTwo.json()]);
    expect(pages).toEqual(expect.arrayContaining([[first], [second]]));

    const pageThree = await fetchPage(3);
    expect(pageThree.headers.get('Total-Number')).toBe('2');
    expect(await pageThree.json()).toEqual([]);
  });

  (isDevFeaturesEnabled ? it : it.skip)('should reject invalid pagination parameters', async () => {
    await expectRejects(authedAdminApi.get('organization-invitations?page_size=101'), {
      code: 'guard.invalid_pagination',
      status: 400,
    });
  });
});
