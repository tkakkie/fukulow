import { sessionIndex } from './scheduler.ts';

export function sessionLayout(sockets: number, socketsPerSession: number, socketsPerAccount: number, publishMembers: number) {
  const socketSessions = Math.ceil(sockets / socketsPerSession);
  const socketAccounts = socketsPerAccount ? socketSessions : 1;
  const ownerSessions = socketsPerAccount ? 1 : socketSessions;
  const accounts = Math.max(socketAccounts, publishMembers);
  return {
    accounts, ownerSessions, socketAccounts, socketSessions,
    sessionsToProvision: ownerSessions + accounts - 1,
    socketTokenIndex: (socket: number) => sessionIndex(socket, socketsPerSession),
    publisherTokenIndex: (member: number) => member === 0 ? 0 : ownerSessions + member - 1,
  };
}
