import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsIn,
  IsArray,
  ArrayNotEmpty,
  IsUrl,
  IsBoolean,
  MaxLength,
} from 'class-validator';

/** Longest client_name accepted from DCR and CIMD; it is rendered on the consent page. */
export const CLIENT_NAME_MAX_LENGTH = 100;

/** Query params for GET /oauth/authorize */
export class AuthorizeQuery {
  @IsString()
  @IsNotEmpty()
  @IsIn(['code'])
  response_type!: string;

  @IsString()
  @IsNotEmpty()
  client_id!: string;

  @IsString()
  @IsNotEmpty()
  redirect_uri!: string;

  @IsString()
  @IsOptional()
  scope?: string;

  @IsString()
  @IsOptional()
  state?: string;

  @IsString()
  @IsNotEmpty()
  code_challenge!: string;

  @IsString()
  @IsNotEmpty()
  @IsIn(['S256'])
  code_challenge_method!: string;

  /** RFC 8707 resource indicator; checked against OAUTH_RESOURCES. */
  @IsString()
  @IsOptional()
  resource?: string;
}

/** Body for POST /oauth/token (application/x-www-form-urlencoded or JSON) */
export class TokenBody {
  @IsString()
  @IsNotEmpty()
  @IsIn([
    'authorization_code',
    'refresh_token',
    'urn:ietf:params:oauth:grant-type:token-exchange',
  ])
  grant_type!: string;

  // authorization_code grant
  @IsString()
  @IsOptional()
  code?: string;

  @IsString()
  @IsOptional()
  redirect_uri?: string;

  /**
   * Required for the authorization_code and refresh_token grants (checked in
   * OAuthService.token). A token-exchange caller authenticates with HTTP Basic
   * instead, so it may omit this.
   */
  @IsString()
  @IsOptional()
  client_id?: string;

  @IsString()
  @IsOptional()
  code_verifier?: string;

  // refresh_token grant
  @IsString()
  @IsOptional()
  refresh_token?: string;

  /** RFC 8707 resource indicator; must match the one used at authorize. */
  @IsString()
  @IsOptional()
  resource?: string;

  // token-exchange grant (RFC 8693, C-5)
  @IsString()
  @IsOptional()
  subject_token?: string;

  @IsString()
  @IsOptional()
  subject_token_type?: string;

  /** RFC 8693 target; equivalent to `resource` and must agree with it. */
  @IsString()
  @IsOptional()
  audience?: string;

  /** Requested scope for the exchange (must be a subset of the subject's). */
  @IsString()
  @IsOptional()
  scope?: string;
}

/** Body for POST /oauth/revoke */
export class RevokeBody {
  @IsString()
  @IsNotEmpty()
  token!: string;

  @IsString()
  @IsNotEmpty()
  client_id!: string;
}

/** Response shape for POST /oauth/token */
export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
  refresh_token: string;
}

/** Response shape for the token-exchange grant: no refresh token (C-5). */
export interface TokenExchangeResponse {
  access_token: string;
  issued_token_type: 'urn:ietf:params:oauth:token-type:access_token';
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
}

/** Client credentials from an HTTP Basic header (client_secret_basic). */
export interface ClientCredentials {
  clientId: string;
  clientSecret: string;
}

/** Item in GET /oauth/clients response */
export interface OAuthClientSession {
  clientId: string;
  clientName: string;
  /** Host the user can verify: the client_id host (CIMD) or the redirect URI host. */
  clientDomain?: string;
  domainSource?: 'client_id' | 'redirect_uri';
  /** True for static-config clients; false for DCR and CIMD apps. */
  isFirstParty: boolean;
  scope: string;
  sessionId: string;
  lastRotatedAt: string;
}

/** Body for POST /oauth/clients/register — RFC 7591 dynamic client registration */
export class RegisterClientBody {
  /** Shown verbatim on the consent page, so it is capped (CLIENT_NAME_MAX_LENGTH). */
  @IsString()
  @IsNotEmpty()
  @MaxLength(CLIENT_NAME_MAX_LENGTH)
  client_name!: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsUrl({ require_tld: false }, { each: true })
  redirect_uris!: string[];

  @IsString()
  @IsOptional()
  scope?: string;

  @IsArray()
  @IsOptional()
  @IsString({ each: true })
  grant_types?: string[];

  /** RFC 7591 application_type; defaults to 'web'. */
  @IsOptional()
  @IsIn(['native', 'web'])
  application_type?: 'native' | 'web';
}

/** Response shape for POST /oauth/clients/register */
export interface RegisterClientResponse {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  scope: string;
  token_endpoint_auth_method: 'none'; // public client
  application_type: 'native' | 'web';
  pkce_required: true;
}

/** Body for POST /oauth/consent/:requestId */
export class ConsentBody {
  @IsBoolean()
  approve!: boolean;
}

/** Response for GET /oauth/consent/:requestId (public — fetched by Next.js consent page) */
export interface ConsentDetails {
  requestId: string;
  clientId: string;
  clientName: string;
  clientDomain?: string;
  domainSource?: 'client_id' | 'redirect_uri';
  isFirstParty: boolean;
  scopes: string[];
  expiresInSeconds: number;
}

/** Response for POST /oauth/consent/:requestId */
export interface ConsentResult {
  redirectUrl: string;
}
