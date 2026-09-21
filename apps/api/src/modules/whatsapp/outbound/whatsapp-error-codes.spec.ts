import { classifyGraphFailure, metaErrorCode } from './whatsapp-error-codes';

const body = (code: unknown) => ({ error: { message: 'secret detail 5541999990000', type: 'OAuthException', code, fbtrace_id: 'x' } });

describe('Graph API failure classification (Meta error-code table)', () => {
  describe('temporary: trying again later can work', () => {
    it.each([
      [4, 429],
      [2, 503],
      [80007, 429],
      [130429, 429],
      [131000, 500],
      [131048, 429],
      [131049, 429],
      [131052, 500],
      [131056, 429],
      [131057, 503],
      [1, 500],
    ])('code %i (HTTP %i)', (code, http) => {
      expect(classifyGraphFailure(http, body(code))).toEqual({ kind: 'temporary', code: `WA_${code}` });
    });
  });

  describe('permanent: it never will', () => {
    it.each([
      [100, 400],
      [190, 401],
      [200, 401],
      [10, 403],
      [368, 403],
      [130403, 400],
      [130472, 400],
      [131008, 400],
      [131009, 400],
      [131026, 400],
      [131031, 403],
      [131037, 403],
      [131042, 402],
      [131045, 400],
      [131047, 403],
      [131050, 400],
      [131051, 400],
      [131053, 400],
      [131062, 400],
      [132000, 400],
      [132001, 400],
      [132015, 400],
    ])('code %i (HTTP %i)', (code, http) => {
      expect(classifyGraphFailure(http, body(code))).toEqual({ kind: 'permanent', code: `WA_${code}` });
    });
  });

  it('131047 (more than 24 h since the customer wrote): a free-form message is not allowed, so it is permanent, not retried into a wall', () => {
    expect(classifyGraphFailure(403, body(131047))).toEqual({ kind: 'permanent', code: 'WA_131047' });
  });

  describe('a KNOWN Meta code decides, not the HTTP status', () => {
    it('a permanent code with a 5xx status is still permanent, a temporary code with a 4xx status still temporary', () => {
      expect(classifyGraphFailure(500, body(131047)).kind).toBe('permanent');
      expect(classifyGraphFailure(400, body(130429)).kind).toBe('temporary');
    });
  });

  describe('unknown or missing code: the HTTP status decides', () => {
    it.each([
      [429, 'temporary'],
      [500, 'temporary'],
      [502, 'temporary'],
      [503, 'temporary'],
      [504, 'temporary'],
      [400, 'permanent'],
      [401, 'permanent'],
      [403, 'permanent'],
      [404, 'permanent'],
      [413, 'permanent'],
      [422, 'permanent'],
      [301, 'permanent'],
    ])('HTTP %i with no Meta code is %s', (http, kind) => {
      expect(classifyGraphFailure(http, null)).toEqual({ kind, code: `WA_HTTP_${http}` });
      expect(classifyGraphFailure(http, '<html>bad gateway</html>')).toEqual({ kind, code: `WA_HTTP_${http}` });
      expect(classifyGraphFailure(http, {})).toEqual({ kind, code: `WA_HTTP_${http}` });
    });

    it('an unknown numeric code keeps its number in the stored code and follows the status', () => {
      expect(classifyGraphFailure(500, body(999999))).toEqual({ kind: 'temporary', code: 'WA_999999' });
      expect(classifyGraphFailure(400, body(999999))).toEqual({ kind: 'permanent', code: 'WA_999999' });
    });

    it('not every 4xx is treated alike: 429 is temporary, credential errors and bad requests are permanent', () => {
      expect(classifyGraphFailure(429, null).kind).toBe('temporary');
      expect(classifyGraphFailure(401, null).kind).toBe('permanent');
      expect(classifyGraphFailure(400, null).kind).toBe('permanent');
    });
  });

  describe('what reaches the stored code', () => {
    it('is only WA_<number> or WA_HTTP_<status>, never Meta\'s message text', () => {
      for (const [http, payload] of [[400, body(100)], [500, body(131000)], [404, body('not-a-number')], [429, { error: { code: 4, message: 'call to +5541999990000' } }]] as const) {
        const { code } = classifyGraphFailure(http, payload);
        expect(code).toMatch(/^WA_(HTTP_)?\d{1,9}$/);
        expect(code).not.toMatch(/secret|5541999990000/);
      }
    });

    it.each([['4'], [1.5], [-1], [1e12], [null], [undefined], [{}], [[]]])('a non-integer or out-of-range code %p is ignored', (code) => {
      expect(metaErrorCode(body(code))).toBeNull();
    });

    it.each([[null], [undefined], ['x'], [42], [[]], [{}], [{ error: null }], [{ error: 'x' }], [{ error: [] }]])('body %p has no code', (payload) => {
      expect(metaErrorCode(payload)).toBeNull();
    });
  });
});
