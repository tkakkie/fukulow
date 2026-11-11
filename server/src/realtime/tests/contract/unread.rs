use super::*;

impl Runner {
    pub(super) async fn mark_read(
        &self,
        step: usize,
        member: &str,
        channels: ChannelRef,
        topic: Option<String>,
        seq: i64,
        expected: i64,
    ) -> Result<(), Failure> {
        for label in channels.labels() {
            let channel = self.channels[&label];
            let suffix = topic.as_ref().map_or_else(
                || "read".into(),
                |name| {
                    format!(
                        "topics/{}/read",
                        self.topics[&(channel, name.clone())].as_str().unwrap()
                    )
                },
            );
            let (status, body) = http::request(
                self.server.address,
                "PUT",
                format!("/api/v1/channels/{channel}/{suffix}"),
                &self.members[member].token,
                json!({"read_seq":seq}),
            )
            .await;
            if status != 200 || body != json!({"read_seq":expected}) {
                eprintln!("mark_read expected {expected}, got {status} {body}");
                return Err(Failure::Unread { step });
            }
        }
        Ok(())
    }

    pub(super) async fn unread(
        &self,
        step: usize,
        member: &str,
        channels: ChannelRef,
        expect: UnreadExpectation,
    ) -> Result<(), Failure> {
        let token = &self.members[member].token;
        let (status, list) = http::request(
            self.server.address,
            "GET",
            "/api/v1/channels",
            token,
            Value::Null,
        )
        .await;
        if status != 200 {
            return Err(Failure::Unread { step });
        }
        for label in channels.labels() {
            let channel = self.channels[&label];
            let Some(c) = list["channels"]
                .as_array()
                .unwrap()
                .iter()
                .find(|c| c["id"] == json!(channel))
            else {
                return Err(Failure::Unread { step });
            };
            if c["as_of_seq"] != expect.as_of_seq
                || c["read_seq"] != expect.read_seq
                || c["main_unread_count"] != expect.main_unread_count
                || c["unread_count"] != expect.unread_count
            {
                eprintln!("Unread expected {expect:?}, got {c}");
                return Err(Failure::Unread { step });
            }
            let (status, page) = http::request(
                self.server.address,
                "GET",
                format!("/api/v1/channels/{channel}/topics"),
                token,
                Value::Null,
            )
            .await;
            if status != 200 {
                return Err(Failure::Unread { step });
            }
            let counts = page["topics"]
                .as_array()
                .unwrap()
                .iter()
                .map(|t| {
                    (
                        t["name"].as_str().unwrap().to_string(),
                        json!({"read_seq":t["read_seq"],"unread_count":t["unread_count"]}),
                    )
                })
                .collect::<std::collections::BTreeMap<_, _>>();
            if json!(counts) != json!(expect.topic_counts) {
                eprintln!(
                    "Unread Topics expected {:?}, got {counts:?}",
                    expect.topic_counts
                );
                return Err(Failure::Unread { step });
            }
        }
        Ok(())
    }
}
