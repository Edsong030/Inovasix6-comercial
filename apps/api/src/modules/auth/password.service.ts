import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

/**
 * Password hashing with Argon2id.
 *
 * Argon2id is preferred over bcrypt: it is memory-hard (resistant to GPU/ASIC
 * attacks), is the OWASP-recommended default, and has no 72-byte input limit.
 * argon2.verify() is constant-time. Parameters below follow current OWASP
 * guidance for interactive logins.
 */
@Injectable()
export class PasswordService {
  private readonly options = {
    type: argon2.argon2id,
    memoryCost: 19456, // 19 MiB
    timeCost: 2,
    parallelism: 1,
  } as const;

  hash(plain: string): Promise<string> {
    return argon2.hash(plain, this.options);
  }

  /** Constant-time verification. Never throws on mismatch; returns false. */
  async verify(hash: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      return false;
    }
  }

  /** True when the stored hash was produced with weaker params and should be re-hashed on next login. */
  needsRehash(hash: string): boolean {
    try {
      return argon2.needsRehash(hash, this.options);
    } catch {
      return true;
    }
  }
}
