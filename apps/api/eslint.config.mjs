import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  { files: ['**/*.ts'], rules: { '@typescript-eslint/no-explicit-any': 'error' } },
  // Test files use `any` for lightweight test doubles/mocks; relax there only.
  {
    files: ['**/*.spec.ts', '**/*.integration-spec.ts', '**/*.e2e-spec.ts', 'test/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  // Business modules must go through TenantAwareRepository / runWithTenant, never
  // the root Prisma client model delegates. This is a backstop for the RLS
  // access convention; PrismaService/repositories themselves are exempt.
  {
    files: ['src/modules/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "MemberExpression[object.property.name='prisma'][property.name=/^(user|role|userRole|authSession|contact|pipeline|pipelineStage|lead|conversation|message|auditLog|tenant)$/]",
          message:
            'Do not access Prisma model delegates directly in business modules. Use a TenantAwareRepository (runWithTenant) so queries run inside the tenant RLS transaction.',
        },
      ],
    },
  },
);
