// Extract sub from JWT token cookie at the router level; set x-user-id for all subgraphs.
fn router_service(service) {
    let request_callback = |request| {
        let cookie_header = request.headers["cookie"];
        if cookie_header == () {
            return;
        }
        let cookie_str = cookie_header.to_string();
        if cookie_str == "" {
            return;
        }

        // Find "token=" in the cookie string
        let prefix = "token=";
        let idx = cookie_str.index_of(prefix);
        if idx < 0 {
            return;
        }

        // Extract token value from idx+len(prefix) until next ";" or end
        let start = idx + prefix.len();
        let rest = cookie_str.sub_string(start);
        let end_idx = rest.index_of(";");
        let token = if end_idx < 0 { rest } else { rest.sub_string(0, end_idx) };

        if token == "" {
            return;
        }

        // Split JWT and decode payload
        let dot1 = token.index_of(".");
        if dot1 < 0 { return; }
        let after1 = token.sub_string(dot1 + 1);
        let dot2 = after1.index_of(".");
        if dot2 < 0 { return; }
        let b64 = after1.sub_string(0, dot2);

        // Pad base64
        let rem = b64.len() % 4;
        if rem == 2 { b64 += "==" }
        else if rem == 3 { b64 += "=" }

        let decoded = "";
        try { decoded = base64::decode(b64); } catch { return; }
        if decoded == () || decoded == "" { return; }

        let sub = "";
        try {
            let obj = parse_json(decoded);
            sub = obj["sub"].to_string();
        } catch { return; }

        if sub != "" {
            request.headers["x-user-id"] = sub;
        }
    };
    service.map_request(request_callback);
}
