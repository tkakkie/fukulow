use super::*;
use serde::Deserialize;

mod assertions;
mod capacity;
pub(super) mod http;
mod model;
mod negative;
mod replies;
mod timeline;
mod unread;
use assertions::{Assertion, Failure};
use model::*;

struct Member {
    organization: Uuid,
    id: Uuid,
    token: String,
}

struct Runner {
    pool: PgPool,
    server: Server,
    delivery: messages::Delivery,
    members: HashMap<String, Member>,
    channels: HashMap<String, Uuid>,
    sockets: HashMap<String, Client>,
    gates: HashMap<Uuid, Arc<Gate>>,
    keys: HashMap<String, Uuid>,
    posts: HashMap<String, Value>,
    records: HashMap<(Uuid, i64), Value>,
    topics: HashMap<(Uuid, String), Value>,
}

impl Drop for Runner {
    fn drop(&mut self) {
        for (channel, gate) in &self.gates {
            GATES.lock().unwrap().remove(channel);
            gate.release.add_permits(1);
        }
    }
}

impl Runner {
    async fn setup(pool: PgPool, setup: Setup) -> Result<Self, Failure> {
        for channel in &setup.channels {
            if channel.visibility == "public" && channel.members.is_some() {
                return Err(Failure::PublicMembers(channel.id.clone()));
            }
        }
        let state = state(&pool).await;
        let delivery = state.message_delivery.clone();
        let server = Server::start(crate::app(state)).await;
        let mut runner = Self {
            pool,
            server,
            delivery,
            members: HashMap::new(),
            channels: HashMap::new(),
            sockets: HashMap::new(),
            gates: HashMap::new(),
            keys: HashMap::new(),
            posts: HashMap::new(),
            records: HashMap::new(),
            topics: HashMap::new(),
        };
        let mut organizations = HashMap::new();
        for label in setup.organizations {
            organizations.insert(label, organization(&runner.pool).await);
        }
        for spec in setup.members {
            let organization = organizations[&spec.organization];
            let (id, token) = member(&runner.pool, organization).await;
            runner.members.insert(
                spec.id,
                Member {
                    organization,
                    id,
                    token,
                },
            );
        }
        for spec in setup.channels {
            let organization = organizations[&spec.organization];
            let creator = runner.members[&spec.creator].id;
            assert_eq!(runner.members[&spec.creator].organization, organization);
            for label in spec.labels() {
                let id = channel(
                    &runner.pool,
                    organization,
                    creator,
                    spec.visibility == "private",
                )
                .await;
                runner.channels.insert(label.clone(), id);
                if spec.visibility == "private" {
                    for label in spec.members.as_deref().unwrap_or_default() {
                        sqlx::query("INSERT INTO channel_members (organization_id, channel_id, member_id) VALUES ($1, $2, $3)")
                            .bind(organization).bind(id).bind(runner.members[label].id)
                            .execute(&runner.pool).await.unwrap();
                    }
                }
                // Seed through HTTP too, retaining the canonical records for exact replay checks.
                for _ in 0..spec.messages {
                    runner.post(&spec.creator, id, None, 201).await;
                }
            }
        }
        for label in setup.unknown_channels {
            runner.channels.insert(label, Uuid::new_v4());
        }
        Ok(runner)
    }

    fn post_input(&mut self, key: Option<&str>) -> Value {
        let key = key.map_or_else(Uuid::new_v4, |label| {
            *self.keys.entry(label.into()).or_insert_with(Uuid::new_v4)
        });
        json!({"client_message_id":key,"body":format!("Message {key}")})
    }

    async fn post(&mut self, member: &str, channel: Uuid, key: Option<&str>, status: u16) -> Value {
        let input = self.post_input(key);
        let (actual_status, record) = http::request(
            self.server.address,
            "POST",
            &format!("/api/v1/channels/{channel}/messages"),
            &self.members[member].token,
            input,
        )
        .await;
        assert_eq!(actual_status, status, "POST response: {record}");
        self.remember(channel, member, &record, status);
        record
    }

    async fn run(pool: PgPool, scenario: Scenario) -> Result<(), Failure> {
        eprintln!(
            "contract scenario: {} (existing tests retained: {:?})",
            scenario.id, scenario.rust.existing_tests
        );
        let mut runner = Self::setup(pool, scenario.setup).await?;
        for (index, step) in scenario.steps.into_iter().enumerate() {
            eprintln!("  {} step {}: {step:?}", scenario.id, index + 1);
            runner.step(index, step).await?;
        }
        Ok(())
    }

    async fn step(&mut self, index: usize, step: Step) -> Result<(), Failure> {
        match step {
            Step::ActivityExpect { socket, mut events } => {
                for notice in &mut events {
                    if let Some(channel) = notice.get("channel_id").and_then(Value::as_str) {
                        notice["channel_id"] = json!(self.channels[channel]);
                    }
                }
                let actual = super::activity::collect(
                    &self.delivery.channel_access.activity,
                    self.sockets.get_mut(&socket).unwrap(),
                )
                .await;
                assert_eq!(actual, events);
            }
            Step::Connect {
                socket,
                member,
                expect_handshake,
            } => {
                let result = self
                    .server
                    .handshake(Some(&self.members[&member].token), None, None)
                    .await;
                if let Some(status) = expect_handshake {
                    rejected(result, status);
                } else {
                    assert!(self.sockets.insert(socket, result.unwrap()).is_none());
                }
            }
            Step::CloseSocket { socket } => {
                self.sockets.remove(&socket).unwrap();
            }
            Step::Subscribe {
                socket,
                channel,
                after_seq,
            } => {
                for label in channel.labels() {
                    subscribe(
                        self.sockets.get_mut(&socket).unwrap(),
                        self.channels[&label],
                        after_seq,
                    )
                    .await;
                }
            }
            Step::Unsubscribe { socket, channel } => {
                for label in channel.labels() {
                    control(
                        self.sockets.get_mut(&socket).unwrap(),
                        ClientMessage::Unsubscribe {
                            channel_id: self.channels[&label],
                        },
                    )
                    .await
                    .unwrap();
                }
            }
            Step::Post(spec) => self.posts(spec).await,
            Step::MarkRead {
                member,
                channel,
                topic_name,
                read_seq,
                expect_read_seq,
            } => {
                self.mark_read(
                    index,
                    &member,
                    channel,
                    topic_name,
                    read_seq,
                    expect_read_seq,
                )
                .await?;
            }
            Step::Unread {
                member,
                channel,
                expect,
            } => {
                self.unread(index, &member, channel, expect).await?;
            }
            Step::HoldReplay { channel } => {
                for label in channel.labels() {
                    let id = self.channels[&label];
                    assert!(self.gates.insert(id, pause(id)).is_none());
                }
            }
            Step::AwaitReplayHeld { channel } => {
                for label in channel.labels() {
                    entered(&self.gates[&self.channels[&label]]).await;
                }
            }
            Step::ReleaseReplay { channel } => {
                for label in channel.labels() {
                    self.gates
                        .remove(&self.channels[&label])
                        .unwrap()
                        .release
                        .add_permits(1);
                }
            }
            Step::RemoveMembership { member, channel } => {
                let member = &self.members[&member];
                for label in channel.labels() {
                    let result = sqlx::query("DELETE FROM channel_members WHERE organization_id = $1 AND channel_id = $2 AND member_id = $3")
                        .bind(member.organization).bind(self.channels[&label]).bind(member.id)
                        .execute(&self.pool).await.unwrap();
                    assert_eq!(result.rows_affected(), 1);
                }
            }
            Step::SignOut { member } => {
                let (status, _) = http::request(
                    self.server.address,
                    "DELETE",
                    "/api/v1/session",
                    &self.members[&member].token,
                    Value::Null,
                )
                .await;
                assert_eq!(status, 204);
            }
            Step::History(spec) => self.history(spec).await,
            Step::ReplyChain(spec) => self.chain(index, spec).await?,
            Step::MainTimeline(spec) => self.timeline(index, spec).await?,
            Step::Expect { socket, events } => {
                for (event, expected) in events.into_iter().enumerate() {
                    self.expect(&socket, expected).await.map_err(|assertion| {
                        Failure::Expectation {
                            step: index,
                            event,
                            assertion,
                        }
                    })?;
                }
            }
        }
        Ok(())
    }

    async fn posts(&mut self, spec: PostSpec) {
        let PostSpec {
            member,
            channel,
            count,
            concurrent,
            key,
            label,
            topic_name,
            reply_to,
            expect_status,
        } = spec;
        let mut first = None;
        for channel in channel.labels() {
            let channel = self.channels[&channel];
            if concurrent {
                // Poll all real HTTP requests concurrently; keep response order for label binding.
                let requests = (0..count)
                    .map(|_| {
                        let mut input = self.post_input(key.as_deref());
                        if let Some(label) = &reply_to {
                            input["reply_to"] = self.posts[label]["id"].clone();
                        }
                        if let Some(name) = &topic_name {
                            input["topic_name"] = json!(name);
                        }
                        http::request(
                            self.server.address,
                            "POST",
                            format!("/api/v1/channels/{channel}/messages"),
                            self.members[&member].token.clone(),
                            input,
                        )
                    })
                    .collect::<Vec<_>>();
                for (status, record) in futures_util::future::join_all(requests).await {
                    assert_eq!(status, expect_status, "POST response: {record}");
                    self.remember(channel, &member, &record, status);
                    self.remember_topic(channel, topic_name.as_deref(), &record, status);
                    first.get_or_insert(record);
                }
            } else {
                for _ in 0..count {
                    let mut input = self.post_input(key.as_deref());
                    if let Some(label) = &reply_to {
                        input["reply_to"] = self.posts[label]["id"].clone();
                    }
                    if let Some(name) = &topic_name {
                        input["topic_name"] = json!(name);
                    }
                    let (status, record) = http::request(
                        self.server.address,
                        "POST",
                        format!("/api/v1/channels/{channel}/messages"),
                        &self.members[&member].token,
                        input,
                    )
                    .await;
                    assert_eq!(status, expect_status, "POST response: {record}");
                    self.remember(channel, &member, &record, status);
                    self.remember_topic(channel, topic_name.as_deref(), &record, status);
                    first.get_or_insert(record);
                }
            }
        }
        if let Some(label) = label {
            self.posts.insert(label, first.unwrap());
        }
    }

    async fn history(&mut self, spec: HistorySpec) {
        let HistorySpec {
            member,
            channel,
            query,
            expect,
        } = spec;
        for label in channel.labels() {
            let id = self.channels[&label];
            let query = query
                .iter()
                .map(|(key, value)| format!("{key}={value}"))
                .collect::<Vec<_>>()
                .join("&");
            let (status, page) = http::request(
                self.server.address,
                "GET",
                format!("/api/v1/channels/{id}/messages?{query}"),
                &self.members[&member].token,
                Value::Null,
            )
            .await;
            assert_eq!(status, expect.status, "history response: {page}");
            if let Some(seqs) = &expect.seqs {
                let expected = seqs
                    .iter()
                    .flat_map(Seq::values)
                    .map(|seq| self.records[&(id, seq)].clone())
                    .collect::<Vec<_>>();
                assert_eq!(page["messages"], json!(expected));
            }
            if let Some(has_more) = expect.has_more {
                assert_eq!(page["has_more"], has_more);
            }
        }
    }

    fn remember_topic(&mut self, channel: Uuid, name: Option<&str>, record: &Value, status: u16) {
        if status == 201
            && let Some(name) = name
        {
            let topic = &record["topic_id"];
            assert!(topic.is_string(), "Topic send must return topic_id");
            let bound = self
                .topics
                .entry((channel, name.into()))
                .or_insert_with(|| topic.clone());
            assert_eq!(bound, topic, "Topic sends must join the same Topic");
        }
    }

    fn remember(&mut self, channel: Uuid, member: &str, record: &Value, status: u16) {
        if status == 201 {
            assert_eq!(record["channel_id"], json!(channel));
            assert_eq!(record["sender"], json!(self.members[member].id));
            let seq = record["seq"].as_i64().unwrap();
            if let Some(previous) = self.records.insert((channel, seq), record.clone()) {
                assert_eq!(*record, previous, "retry must return the canonical Message");
            }
        }
    }

    async fn expect(&mut self, socket: &str, expected: Event) -> Result<(), Assertion> {
        if matches!(expected, Event::Silent { .. }) {
            self.delivery.flush().await;
        }
        match &expected {
            Event::ChannelAccessLost { channel }
            | Event::Message { channel, .. }
            | Event::Subscribed { channel, .. }
            | Event::Error {
                channel: Some(channel),
                ..
            } if channel.labels().is_empty() => {
                return Err(Assertion::EmptyChannel);
            }
            _ => {}
        }
        let client = self.sockets.get_mut(socket).unwrap();
        match expected {
            Event::Silent { barrier } => {
                assertions::silence(
                    client,
                    self.channels[&barrier.channel],
                    barrier.caught_up_seq,
                )
                .await?;
            }
            Event::Closed { code } => assertions::closed(client, code).await?,
            Event::Subscribed {
                channel,
                caught_up_seq,
            } => {
                for label in channel.labels() {
                    assertions::json(client, json!({"type":"subscribed","channel_id":self.channels[&label],"caught_up_seq":caught_up_seq}), Assertion::Subscribed).await?;
                }
            }
            Event::ChannelAccessLost { channel } => {
                for label in channel.labels() {
                    assertions::json(
                        client,
                        json!({"type":"channel_access_lost","channel_id":self.channels[&label]}),
                        Assertion::Error,
                    )
                    .await?;
                }
            }
            Event::Error { channel, code } => {
                let channels = channel.map_or_else(
                    || vec![None],
                    |channels| {
                        channels
                            .labels()
                            .into_iter()
                            .map(|label| Some(self.channels[&label]))
                            .collect()
                    },
                );
                for id in channels {
                    let mut expected = json!({"type":"error","code":code});
                    if let Some(id) = id {
                        expected["channel_id"] = json!(id);
                    }
                    assertions::json(client, expected, Assertion::Error).await?;
                }
            }
            Event::Message {
                channel,
                seqs,
                from_post,
            } => {
                if seqs.as_ref().is_some_and(Vec::is_empty)
                    || (seqs.is_none() && from_post.is_none())
                {
                    return Err(Assertion::EmptyMessage);
                }
                for label in channel.labels() {
                    let channel = self.channels[&label];
                    let records = if let Some(seqs) = &seqs {
                        seqs.iter()
                            .flat_map(Seq::values)
                            .map(|seq| &self.records[&(channel, seq)])
                            .collect::<Vec<_>>()
                    } else {
                        vec![&self.posts[from_post.as_ref().unwrap()]]
                    };
                    if records.is_empty() {
                        return Err(Assertion::EmptyMessage);
                    }
                    for record in records {
                        if let Some(post) = &from_post {
                            assert_eq!(*record, self.posts[post]);
                        }
                        assert_eq!(record["channel_id"], json!(channel));
                        assertions::json(
                            client,
                            json!({"type":"message","message":record}),
                            Assertion::Message,
                        )
                        .await?;
                    }
                }
            }
        }
        Ok(())
    }
}

fn scenarios() -> Vec<Scenario> {
    fixtures().0
}

/// Running scenarios, and the proposed ones (validated by web/scripts/realtime-fixtures.ts, not run here).
fn fixtures() -> (Vec<Scenario>, Vec<Value>) {
    let dir =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../contract/realtime/delivery");
    let mut paths = std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect::<Vec<_>>();
    paths.sort();
    assert!(!paths.is_empty(), "no delivery fixture files");
    let (proposed, running): (Vec<_>, Vec<_>) = paths
        .into_iter()
        .flat_map(|path| {
            let file: File = serde_json::from_slice(&std::fs::read(&path).unwrap())
                .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
            assert_eq!(file.kind, "delivery");
            assert!(!file.scenarios.is_empty());
            file.scenarios
        })
        .partition(|scenario| scenario.get("proposed").is_some());
    let running = running
        .into_iter()
        .map(|scenario| {
            let id = scenario["id"].clone();
            serde_json::from_value(scenario).unwrap_or_else(|error| panic!("{id}: {error}"))
        })
        .collect();
    (running, proposed)
}

#[sqlx::test]
async fn delivery_contract_scenarios(pool: PgPool) {
    let filter = std::env::var("REALTIME_CONTRACT_SCENARIO").ok();
    let (scenarios, proposed) = fixtures();
    for scenario in &proposed {
        eprintln!(
            "contract scenario skipped (proposed, owner {}): {}",
            scenario["proposed"]["owner"], scenario["id"]
        );
    }
    let scenarios = scenarios
        .into_iter()
        .filter(|scenario| filter.as_ref().is_none_or(|id| scenario.id == *id))
        .collect::<Vec<_>>();
    assert!(!scenarios.is_empty(), "no matching delivery scenario");
    for scenario in scenarios {
        Runner::run(pool.clone(), scenario).await.unwrap();
    }
}
