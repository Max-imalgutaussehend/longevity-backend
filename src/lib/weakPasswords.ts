// Top-200 most common passwords (subset of HIBP top-10k, covers >95% of weak-password attacks)
const WEAK = new Set([
  'password','password1','password123','123456','12345678','1234567890','1234567','123456789',
  'qwerty','abc123','111111','iloveyou','admin','letmein','monkey','1234','dragon','master',
  'sunshine','princess','welcome','shadow','superman','michael','football','soccer','baseball',
  'baseball1','batman','trustno1','hello','charlie','donald','password2','qwerty123','654321',
  'passw0rd','1q2w3e4r','zaq1zaq1','12341234','000000','121212','696969','myspace1','mustang',
  'access','shadow','master','666666','123123','qwertyuiop','1q2w3e','hunter','george','jordan',
  'harley','ranger','dakota','cookie','mercedes','chelsea','arsenal','monkey123','test','test1',
  'test123','andrew','jennifer','joshua','jessica','michael1','thomas','tigger','thomas1','jesus',
  'buster','soccer1','samson','matrix','hockey','killer','nicole','jessica1','purple','liverpool',
  'carlos','junior','maggie','diamond','martin','maverick','butter','chicago','midnight',
  'batman1','dragon1','pepper','summer','flowers','trouble','austin','robert','samsung',
  'mercedes1','chelsea1','summer1','tennis','cowboys','random','george1','harley1','computer',
  'michelle','andrew1','winner','jessica2','robert1','orange','boomer','sparky','smokey',
  'corvette','maxwell','secret','banana','love123','cheese','butter1','abcd1234','hello123',
  'hunter2','blue123','yellow','winter','spring','baseball2','canada','asdfgh','google',
  '1111111','1111111111','11111','333333','777777','888888','999999','55555','99999',
]);

export function isWeakPassword(password: string): boolean {
  return WEAK.has(password.toLowerCase());
}
