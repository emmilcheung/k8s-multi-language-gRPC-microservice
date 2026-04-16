import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsIn,
  IsArray,
  ArrayNotEmpty,
  IsUrl,
  IsBoolean,
} from 'class-validator';

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
}

/** Body for POST /oauth/token (application/x-www-form-urlencoded or JSON) */
export class TokenBody {
  @IsString()
  @IsNotEmpty()
  @IsIn(['authorization_code', 'refresh_token'])
  grant_type!: string;

  // authorization_code grant
  @IsString()
  @IsOptional()
  code?: string;

  @IsString()
  @IsOptional()
  redirect_uri?: string;

  @IsString()
  @IsNotEmpty()
  client_id!: string;

  @IsString()
  @IsOptional()
  code_verifier?: string;

  // refresh_token grant
  @IsString()
  @IsOptional()
  refresh_token?: string;
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

/** Item in GET /oauth/clients response */
export interface OAuthClientSession {
  clientId: string;
  clientName: string;
  scope: string;
  sessionId: string;
  lastRotatedAt: string;
}

/** Body for POST /oauth/clients/register — RFC 7591 dynamic client registration */
export class RegisterClientBody {
  @IsString()
  @IsNotEmpty()
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
}

/** Response shape for POST /oauth/clients/register */
export interface RegisterClientResponse {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  scope: string;
  token_endpoint_auth_method: 'none'; // public client
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
  scopes: string[];
  expiresInSeconds: number;
}

/** Response for POST /oauth/consent/:requestId */
export interface ConsentResult {
  redirectUrl: string;
}
