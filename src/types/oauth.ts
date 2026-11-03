// OAuth endpoints are intentionally outside the public REST OpenAPI contract.
export interface OAuthMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint: string;
  device_authorization_endpoint: string;
}
export interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope?: string;
}
export interface OAuthErrorResponse {
  error: string;
  error_description?: string;
  interval?: number;
}
export interface DeviceAuthorizationResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}
export interface StoredTokens {
  access_token: string;
  access_expires_at: number;
  refresh_token: string;
}
