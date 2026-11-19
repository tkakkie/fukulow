use super::*;

async fn grant(f: &Fixture, channel: Uuid, id: Uuid, enable: bool) {
    let (method, suffix, input) = if enable {
        (
            "POST",
            format!("/channels/{channel}/members"),
            json!({"member_id":id}),
        )
    } else {
        (
            "DELETE",
            format!("/channels/{channel}/members/{id}"),
            Value::Null,
        )
    };
    expected(f.send(method, &suffix, input).await, StatusCode::NO_CONTENT).await;
}

async fn as_member(f: &Fixture, token: &str, method: &str, suffix: &str, input: Value) -> Response {
    send(&f.app, method, &path(f.owner.org, suffix), token, input).await
}

async fn layout_as(f: &Fixture, token: &str) -> Value {
    expected(
        as_member(f, token, "GET", SECTIONS, Value::Null).await,
        StatusCode::OK,
    )
    .await
}

async fn placement_denials(f: &Fixture, token: &str, section: Uuid, channel: Uuid) {
    let before = layout_as(f, token).await;
    for (method, suffix, input) in [
        ("GET", placement_path(channel), Value::Null),
        (
            "PUT",
            placement_path(channel),
            json!({"section_id":Uuid::new_v4()}),
        ),
        (
            "PUT",
            CHANNEL_ORDER.to_owned(),
            channel_order(Some(section), &[channel]),
        ),
    ] {
        denied(
            as_member(f, token, method, &suffix, input).await,
            StatusCode::NOT_FOUND,
            "channel not found",
        )
        .await;
    }
    assert_eq!(layout_as(f, token).await, before);
}

#[fukulow_test::test]
async fn ownership_and_tenant_denials(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let private = Uuid::new_v4();
    f.create(private, "Private name").await;
    let visible = f.channel("Public", "public").await;
    let target = section_path(private);
    f.changed(
        "PUT",
        &placement_path(visible),
        json!({"section_id":private}),
    )
    .await;
    let original = f.get(SECTIONS).await;
    let foreign_org = organization(&f.pools.admin).await;
    let foreign_token = member(&f.pools.admin, foreign_org, f.owner.member, "owner").await;
    let foreign_section = Uuid::new_v4();
    expected(
        send(
            &f.app,
            "POST",
            &path(foreign_org, SECTIONS),
            &foreign_token,
            json!({"id":foreign_section,"name":"Foreign"}),
        )
        .await,
        StatusCode::CREATED,
    )
    .await;
    denied(
        send(
            &f.app,
            "GET",
            &path(foreign_org, SECTIONS),
            &f.token,
            Value::Null,
        )
        .await,
        StatusCode::NOT_FOUND,
        "organization_unavailable",
    )
    .await;

    for (org, token, guessed) in [
        (
            f.owner.org,
            member(&f.pools.admin, f.owner.org, Uuid::new_v4(), "owner").await,
            private,
        ),
        (
            f.owner.org,
            member(&f.pools.admin, f.owner.org, Uuid::new_v4(), "admin").await,
            private,
        ),
        (f.owner.org, f.token.clone(), foreign_section),
        (foreign_org, foreign_token.clone(), private),
    ] {
        let get = async |s| {
            expected(
                send(&f.app, "GET", &path(org, s), &token, Value::Null).await,
                StatusCode::OK,
            )
            .await
        };
        let before = get(SECTIONS).await;
        for (method, suffix, input) in [
            ("GET", section_path(guessed), Value::Null),
            ("PATCH", section_path(guessed), json!({"name":"Guessed"})),
            (
                "PUT",
                SECTION_ORDER.to_owned(),
                json!({"section_ids":[guessed]}),
            ),
            (
                "PUT",
                CHANNEL_ORDER.to_owned(),
                channel_order(Some(guessed), &[Uuid::new_v4()]),
            ),
        ] {
            denied(
                send(&f.app, method, &path(org, &suffix), &token, input).await,
                StatusCode::NOT_FOUND,
                "section_not_found",
            )
            .await;
        }
        if org == f.owner.org {
            denied(
                send(
                    &f.app,
                    "PUT",
                    &path(org, &placement_path(visible)),
                    &token,
                    json!({"section_id":guessed}),
                )
                .await,
                StatusCode::NOT_FOUND,
                "section_not_found",
            )
            .await;
        } else {
            denied(
                send(
                    &f.app,
                    "GET",
                    &path(org, &placement_path(visible)),
                    &token,
                    Value::Null,
                )
                .await,
                StatusCode::NOT_FOUND,
                "channel not found",
            )
            .await;
            denied(
                send(
                    &f.app,
                    "PUT",
                    &path(org, &placement_path(visible)),
                    &token,
                    json!({"section_id":foreign_section}),
                )
                .await,
                StatusCode::NOT_FOUND,
                "channel not found",
            )
            .await;
            denied(
                send(
                    &f.app,
                    "PUT",
                    &path(org, CHANNEL_ORDER),
                    &token,
                    channel_order(Some(foreign_section), &[visible]),
                )
                .await,
                StatusCode::NOT_FOUND,
                "channel not found",
            )
            .await;
        }
        expected(
            send(
                &f.app,
                "DELETE",
                &path(org, &section_path(guessed)),
                &token,
                Value::Null,
            )
            .await,
            StatusCode::NO_CONTENT,
        )
        .await;
        assert_eq!(get(SECTIONS).await, before);
        assert_eq!(f.get(SECTIONS).await, original);
        if org == f.owner.org && token != f.token {
            expected(
                as_member(
                    &f,
                    &token,
                    "POST",
                    SECTIONS,
                    json!({"id":private,"name":"Own"}),
                )
                .await,
                StatusCode::CREATED,
            )
            .await;
            let own = get(target.as_str()).await;
            assert_eq!(own["section"]["name"], "Own");
        }
    }
    assert_eq!(f.get(&target).await["section"]["name"], "Private name");
    let positive = expected(
        send(
            &f.app,
            "GET",
            &path(foreign_org, &section_path(foreign_section)),
            &foreign_token,
            Value::Null,
        )
        .await,
        StatusCode::OK,
    )
    .await;
    assert_eq!(positive["section"]["name"], "Foreign");
    let shared_account_org = organization(&f.pools.admin).await;
    sqlx::query(
        "INSERT INTO users (organization_id,id,account_id,name,role)
        SELECT $3,id,account_id,name,'guest' FROM users WHERE organization_id=$1 AND id=$2",
    )
    .bind(f.owner.org)
    .bind(f.owner.member)
    .bind(shared_account_org)
    .execute(&f.pools.admin)
    .await
    .unwrap();
    expected(
        send(
            &f.app,
            "POST",
            &path(shared_account_org, SECTIONS),
            &f.token,
            json!({"id":private,"name":"Same account, different Organization"}),
        )
        .await,
        StatusCode::CREATED,
    )
    .await;
    assert_eq!(
        expected(
            send(
                &f.app,
                "GET",
                &path(shared_account_org, SECTIONS),
                &f.token,
                Value::Null
            )
            .await,
            StatusCode::OK
        )
        .await,
        json!({"generation":"1","sections":[{"id":private,"name":"Same account, different Organization","channel_ids":[]}],"other_channel_ids":[]})
    );
    assert_eq!(f.get(SECTIONS).await, original);
}

#[fukulow_test::test]
async fn private_channel_access_all_roles(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let private = f.channel("Private", "private").await;
    let public = f.channel("Public", "public").await;
    let section = Uuid::new_v4();
    for role in ["owner", "admin", "member", "guest"] {
        let id = Uuid::new_v4();
        let token = member(&f.pools.admin, f.owner.org, id, role).await;
        expected(
            as_member(
                &f,
                &token,
                "POST",
                SECTIONS,
                json!({"id":section,"name":"Mine"}),
            )
            .await,
            StatusCode::CREATED,
        )
        .await;
        let before = layout_as(&f, &token).await;
        assert_eq!(before["sections"][0]["channel_ids"], json!([]));
        placement_denials(&f, &token, section, private).await;
        if role == "guest" {
            assert_eq!(before["other_channel_ids"], json!([]));
            placement_denials(&f, &token, section, public).await;
            grant(&f, public, id, true).await;
            assert_eq!(
                expected(
                    as_member(&f, &token, "GET", &placement_path(public), Value::Null).await,
                    StatusCode::OK
                )
                .await["section_id"],
                Value::Null
            );
            expected(
                as_member(
                    &f,
                    &token,
                    "PUT",
                    CHANNEL_ORDER,
                    channel_order(None, &[public]),
                )
                .await,
                StatusCode::NO_CONTENT,
            )
            .await;
        } else {
            assert_eq!(before["other_channel_ids"], json!([public]));
        }
        grant(&f, private, id, true).await;
        expected(
            as_member(
                &f,
                &token,
                "PUT",
                &placement_path(private),
                json!({"section_id":section}),
            )
            .await,
            StatusCode::NO_CONTENT,
        )
        .await;
        expected(
            as_member(
                &f,
                &token,
                "PUT",
                CHANNEL_ORDER,
                channel_order(Some(section), &[private]),
            )
            .await,
            StatusCode::NO_CONTENT,
        )
        .await;
        f.distinct_positions().await;
        let current = layout_as(&f, &token).await;
        assert_eq!(current["sections"][0]["channel_ids"], json!([private]));
        assert_eq!(
            expected(
                as_member(&f, &token, "GET", &placement_path(private), Value::Null).await,
                StatusCode::OK
            )
            .await,
            json!({"generation":"2","section_id":section})
        );

        grant(&f, private, id, false).await;
        let hidden = layout_as(&f, &token).await;
        assert_eq!(hidden["generation"], "2");
        assert_eq!(
            hidden["sections"],
            json!([{"id":section,"name":"Mine","channel_ids":[]}])
        );
        assert_eq!(
            expected(
                as_member(&f, &token, "GET", &section_path(section), Value::Null).await,
                StatusCode::OK
            )
            .await,
            json!({"generation":"2","section":hidden["sections"][0]})
        );
        placement_denials(&f, &token, section, private).await;
        grant(&f, private, id, true).await;
        assert_eq!(layout_as(&f, &token).await, current);
    }
}

#[fukulow_test::test]
async fn regained_slots_and_reactivation(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let id = Uuid::new_v4();
    let token = member(&f.pools.admin, f.owner.org, id, "member").await;
    let (left, middle, right) = (
        f.channel("Left", "public").await,
        f.channel("Middle", "private").await,
        f.channel("Right", "public").await,
    );
    let section = Uuid::new_v4();
    expected(
        as_member(
            &f,
            &token,
            "POST",
            SECTIONS,
            json!({"id":section,"name":"Personal"}),
        )
        .await,
        StatusCode::CREATED,
    )
    .await;
    grant(&f, middle, id, true).await;
    grant(&f, left, id, true).await;
    for channel in [left, middle, right] {
        expected(
            as_member(
                &f,
                &token,
                "PUT",
                &placement_path(channel),
                json!({"section_id":section}),
            )
            .await,
            StatusCode::NO_CONTENT,
        )
        .await;
        f.distinct_positions().await;
    }
    let before = layout_as(&f, &token).await;
    grant(&f, left, id, false).await;
    assert_eq!(layout_as(&f, &token).await, before);
    grant(&f, middle, id, false).await;
    assert_eq!(
        layout_as(&f, &token).await["sections"][0]["channel_ids"],
        json!([left, right])
    );
    placement_denials(&f, &token, section, middle).await;
    expected(
        as_member(
            &f,
            &token,
            "PUT",
            CHANNEL_ORDER,
            channel_order(Some(section), &[right, left]),
        )
        .await,
        StatusCode::NO_CONTENT,
    )
    .await;
    f.distinct_positions().await;
    grant(&f, middle, id, true).await;
    let reordered = layout_as(&f, &token).await;
    assert_eq!(
        reordered["sections"][0]["channel_ids"],
        json!([right, middle, left])
    );
    assert_eq!(reordered["generation"], "5");

    expected(
        f.send(
            "PATCH",
            &format!("/members/{id}/role"),
            json!({"role":"guest"}),
        )
        .await,
        StatusCode::OK,
    )
    .await;
    let demoted = layout_as(&f, &token).await;
    assert_eq!(demoted["sections"][0]["channel_ids"], json!([middle]));
    assert_eq!(demoted["generation"], "5");
    placement_denials(&f, &token, section, left).await;
    grant(&f, left, id, true).await;
    assert_eq!(
        layout_as(&f, &token).await["sections"][0]["channel_ids"],
        json!([middle, left])
    );

    let stale = Owner {
        member: id,
        ..f.owner
    };
    expected(
        f.send("POST", &format!("/members/{id}/deactivate"), Value::Null)
            .await,
        StatusCode::NO_CONTENT,
    )
    .await;
    denied(
        as_member(&f, &token, "GET", SECTIONS, Value::Null).await,
        StatusCode::NOT_FOUND,
        "organization_unavailable",
    )
    .await;
    denied(
        as_member(
            &f,
            &token,
            "PUT",
            &placement_path(left),
            json!({"section_id":section}),
        )
        .await,
        StatusCode::NOT_FOUND,
        "organization_unavailable",
    )
    .await;
    denied(
        as_member(
            &f,
            &token,
            "PUT",
            CHANNEL_ORDER,
            channel_order(Some(section), &[left]),
        )
        .await,
        StatusCode::NOT_FOUND,
        "organization_unavailable",
    )
    .await;
    auth::set_member_active_for_test(&f.pools.admin, f.owner.org, id, true).await;
    let reactivated = layout_as(&f, &token).await;
    assert_eq!(reactivated["sections"][0]["channel_ids"], json!([]));
    assert_eq!(reactivated["generation"], "5");
    let stale_read = read::placement(State(f.state.clone()), stale, TargetId(left)).await;
    denied(
        stale_read.err().unwrap().into_response(),
        StatusCode::NOT_FOUND,
        "organization_unavailable",
    )
    .await;
    let error = write::write(
        &f.state,
        activity::Activity::default(),
        stale,
        write::Mutation::Rename(
            section,
            RenameSection {
                name: "Stale".into(),
            },
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(
        (error.0, error.1),
        (StatusCode::NOT_FOUND, "organization_unavailable")
    );
    assert_eq!(layout_as(&f, &token).await, reactivated);
    grant(&f, middle, id, true).await;
    assert_eq!(
        layout_as(&f, &token).await["sections"][0]["channel_ids"],
        json!([middle])
    );

    expected(
        as_member(&f, &token, "DELETE", &section_path(section), Value::Null).await,
        StatusCode::NO_CONTENT,
    )
    .await;
    grant(&f, left, id, true).await;
    assert_eq!(
        layout_as(&f, &token).await,
        json!({"generation":"6","sections":[],"other_channel_ids":[left,middle]})
    );
    let remaining: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM member_section_placements WHERE organization_id=$1 AND member_id=$2",
    )
    .bind(f.owner.org)
    .bind(id)
    .fetch_one(&f.pools.admin)
    .await
    .unwrap();
    assert_eq!(remaining, 0);
}

#[fukulow_test::test]
async fn automatic_tail_noop_and_materialization(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let a = f.channel("Alpha", "public").await;
    let z = f.channel("Zulu", "public").await;
    f.changed("PUT", CHANNEL_ORDER, channel_order(None, &[a, z]))
        .await;
    assert_eq!(
        f.get(SECTIONS).await,
        json!({"generation":"0","sections":[],"other_channel_ids":[a,z]})
    );
    let m = f.channel("Middle", "public").await;
    assert_eq!(f.get(SECTIONS).await["other_channel_ids"], json!([a, m, z]));
    f.changed("PUT", CHANNEL_ORDER, channel_order(None, &[z, m, a]))
        .await;
    f.changed("PUT", CHANNEL_ORDER, channel_order(None, &[z, m, a]))
        .await;
    let extra = f.channel("Aardvark", "public").await;
    assert_eq!(
        f.get(SECTIONS).await,
        json!({"generation":"1","sections":[],"other_channel_ids":[z,m,a,extra]})
    );
}

#[fukulow_test::test]
async fn dm_participants_cannot_place_dms(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let peer = Uuid::new_v4();
    member(&f.pools.admin, f.owner.org, peer, "member").await;
    let response = f.send("POST", "/dms", json!({"member_id":peer})).await;
    let status = response.status();
    assert!(status.is_success());
    let dm: Uuid = serde_json::from_value(expected(response, status).await["id"].clone()).unwrap();
    let group = Uuid::new_v4();
    f.create(group, "Ordinary Channels").await;
    let ordinary = f.channel("Ordinary", "public").await;
    f.changed(
        "PUT",
        &placement_path(ordinary),
        json!({"section_id":group}),
    )
    .await;
    let before = f.get(SECTIONS).await;
    assert_eq!(
        before,
        json!({"generation":"2","sections":[{"id":group,"name":"Ordinary Channels","channel_ids":[ordinary]}],"other_channel_ids":[]})
    );
    placement_denials(&f, &f.token, group, dm).await;
    assert_eq!(f.get(SECTIONS).await, before);
    f.changed(
        "PUT",
        CHANNEL_ORDER,
        channel_order(Some(group), &[ordinary]),
    )
    .await;
}
