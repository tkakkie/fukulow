use super::*;

impl Runner {
    pub(super) async fn chain(&mut self, step: usize, spec: ReplyChainSpec) -> Result<(), Failure> {
        for label in spec.channel.labels() {
            let channel = self.channels[&label];
            let query = spec
                .query
                .iter()
                .map(|(k, v)| format!("{k}={v}"))
                .collect::<Vec<_>>()
                .join("&");
            let anchor = self.posts[&spec.anchor]["id"].as_str().unwrap();
            let (status, page) = http::request(
                self.server.address,
                "GET",
                format!("/api/v1/channels/{channel}/messages/{anchor}/chain?{query}"),
                &self.members[&spec.member].token,
                Value::Null,
            )
            .await;
            let records = spec
                .expect
                .seqs
                .iter()
                .flat_map(Seq::values)
                .map(|seq| self.records[&(channel, seq)].clone())
                .collect::<Vec<_>>();
            assert!(Uuid::parse_str(page["history_generation"].as_str().unwrap()).is_ok());
            assert!(page["as_of_seq"].is_i64());
            let root = &self.posts[&spec.expect.root]["id"];
            let w = page["as_of_seq"].as_i64().unwrap();
            let version = self
                .records
                .iter()
                .filter(|&((id, seq), message)| {
                    *id == channel
                        && *seq <= w
                        && (&message["id"] == root || &message["reply_root_id"] == root)
                })
                .filter_map(|(_, message)| message["version"].as_i64())
                .max();
            let expected = json!({
                "history_generation": page["history_generation"], "as_of_seq": w, "root_id": root,
                "chain_version": version, "messages": records, "has_more": spec.expect.has_more
            });
            if status != spec.expect.status || page != expected {
                eprintln!(
                    "chain: expected status {} {expected}, got {status} {page}",
                    spec.expect.status
                );
                return Err(Failure::Chain { step });
            }
        }
        Ok(())
    }
}

#[fukulow_test::test]
async fn reply_chain_contract_rejects_wrong_root_omissions_order_and_has_more(pool: PgPool) {
    for mutation in 0..4 {
        let mut scenario = super::scenarios()
            .into_iter()
            .find(|s| s.id == "reply-chain-root-descendant-paging-retries-and-stream")
            .unwrap();
        let (step, spec) = scenario
            .steps
            .iter_mut()
            .enumerate()
            .find_map(|(i, s)| {
                if let Step::ReplyChain(spec) = s {
                    Some((i, spec))
                } else {
                    None
                }
            })
            .unwrap();
        match mutation {
            0 => spec.expect.root = "child".into(),
            1 => {
                spec.expect.seqs.remove(0);
            }
            2 => spec.expect.seqs.reverse(),
            _ => spec.expect.has_more = false,
        }
        assert_eq!(
            Runner::run(pool.clone(), scenario).await,
            Err(Failure::Chain { step })
        );
    }
}
