// Replace this provisional type with the generated /credential type once that
// route is published in the gateway OpenAPI. IDs remain decimal/prefixed strings.
export interface Credential {
  credential: { type: string; id: string | null; environment: string };
  principal: { type: string; id: string; name: string };
  organization: { id: string; name: string; type: string };
  permissions: string[];
}
